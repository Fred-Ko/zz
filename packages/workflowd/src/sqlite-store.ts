import { Database } from "bun:sqlite";
import {
	type EpisodeHeartbeatInput,
	type WorkflowEventInput,
	type WorkflowEventResult,
	type WorkflowRecoveryRecord,
	type WorkflowRegistryStore,
	type WorkflowTaskRecord,
	WorkflowVersionConflictError,
	type WorkspaceLeaseInput,
} from "./types";

interface SqliteWorkflowRegistryOptions {
	now?: () => number;
}

interface VersionRow {
	version: number;
}

interface EventVersionRow {
	resulting_version: number;
}

interface TaskRow {
	task_id: string;
	repo_id: string | null;
	phase: string | null;
	version: number;
	state: string;
	updated_at: number;
}

interface PayloadRow {
	payload: string;
}

function recordFromJson(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("workflow registry contains a non-object JSON payload");
	}
	return parsed as Record<string, unknown>;
}

function taskRecord(row: TaskRow): WorkflowTaskRecord {
	return {
		taskId: row.task_id,
		repoId: row.repo_id,
		phase: row.phase,
		version: row.version,
		state: recordFromJson(row.state),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

export class SqliteWorkflowRegistry implements WorkflowRegistryStore {
	readonly #db: Database;
	readonly #now: () => number;

	constructor(databasePath: string, options: SqliteWorkflowRegistryOptions = {}) {
		this.#db = new Database(databasePath, { create: true, strict: true });
		this.#now = options.now ?? Date.now;
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run("PRAGMA foreign_keys = ON");
	}

	async migrate(): Promise<void> {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS workflow_tasks (
				task_id TEXT PRIMARY KEY,
				repo_id TEXT,
				phase TEXT,
				version INTEGER NOT NULL DEFAULT 0,
				state TEXT NOT NULL DEFAULT '{}',
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS workflow_events (
				event_id INTEGER PRIMARY KEY AUTOINCREMENT,
				idempotency_key TEXT NOT NULL UNIQUE,
				task_id TEXT NOT NULL,
				path TEXT NOT NULL,
				expected_version INTEGER NOT NULL,
				resulting_version INTEGER NOT NULL,
				payload TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS workflow_events_task_created
			ON workflow_events(task_id, event_id DESC);
			CREATE TABLE IF NOT EXISTS workflow_workspace_leases (
				workspace_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				episode_id TEXT NOT NULL,
				machine_id TEXT NOT NULL,
				lease_ms INTEGER NOT NULL DEFAULT 90000,
				expires_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS workflow_episode_heartbeats (
				episode_id TEXT PRIMARY KEY,
				machine_id TEXT NOT NULL,
				heartbeat_at INTEGER NOT NULL
			);
		`);
	}

	async applyEvent(input: WorkflowEventInput): Promise<WorkflowEventResult> {
		const apply = this.#db.transaction((event: WorkflowEventInput): WorkflowEventResult => {
			const existing = this.#db
				.prepare<EventVersionRow, [string]>(
					"SELECT resulting_version FROM workflow_events WHERE idempotency_key = ?",
				)
				.get(event.idempotencyKey);
			if (existing) return { version: existing.resulting_version };

			const now = this.#now();
			this.#db
				.prepare("INSERT OR IGNORE INTO workflow_tasks(task_id, updated_at) VALUES (?, ?)")
				.run(event.taskId, now);
			const row = this.#db
				.prepare<VersionRow, [string]>("SELECT version FROM workflow_tasks WHERE task_id = ?")
				.get(event.taskId);
			const currentVersion = row?.version ?? 0;
			if (currentVersion !== event.expectedVersion) {
				throw new WorkflowVersionConflictError(currentVersion);
			}

			const version = currentVersion + 1;
			const state = event.payload.state;
			const stateRecord =
				state !== null && typeof state === "object" && !Array.isArray(state)
					? (state as Record<string, unknown>)
					: undefined;
			const repoId = typeof event.payload.repoId === "string" ? event.payload.repoId : null;
			const phase = typeof stateRecord?.phase === "string" ? stateRecord.phase : null;
			this.#db
				.prepare(
					`UPDATE workflow_tasks
					    SET version = ?,
					        repo_id = COALESCE(?, repo_id),
					        phase = COALESCE(?, phase),
					        state = CASE WHEN ? = 1 THEN ? ELSE state END,
					        updated_at = ?
					  WHERE task_id = ?`,
				)
				.run(version, repoId, phase, stateRecord ? 1 : 0, JSON.stringify(stateRecord ?? {}), now, event.taskId);
			this.#db
				.prepare(
					`INSERT INTO workflow_events(
						idempotency_key, task_id, path, expected_version, resulting_version, payload, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					event.idempotencyKey,
					event.taskId,
					event.path,
					currentVersion,
					version,
					JSON.stringify(event.payload),
					now,
				);
			return { version };
		});
		return apply.immediate(input);
	}

	async acquireLease(input: WorkspaceLeaseInput): Promise<boolean> {
		const now = this.#now();
		const result = this.#db
			.prepare(
				`INSERT INTO workflow_workspace_leases(
					workspace_id, task_id, attempt_id, episode_id, machine_id, lease_ms, expires_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(workspace_id) DO UPDATE SET
					task_id = excluded.task_id,
					attempt_id = excluded.attempt_id,
					episode_id = excluded.episode_id,
					machine_id = excluded.machine_id,
					lease_ms = excluded.lease_ms,
					expires_at = excluded.expires_at,
					updated_at = excluded.updated_at
				WHERE workflow_workspace_leases.expires_at <= ?
				   OR (
						workflow_workspace_leases.task_id = excluded.task_id
					AND workflow_workspace_leases.attempt_id = excluded.attempt_id
					AND workflow_workspace_leases.episode_id = excluded.episode_id
					AND workflow_workspace_leases.machine_id = excluded.machine_id
				   )`,
			)
			.run(
				input.workspaceId,
				input.taskId,
				input.attemptId,
				input.episodeId,
				input.machineId,
				input.leaseMs,
				now + input.leaseMs,
				now,
				now,
			);
		return result.changes === 1;
	}

	async releaseLease(input: WorkspaceLeaseInput): Promise<void> {
		this.#db
			.prepare(
				`DELETE FROM workflow_workspace_leases
				  WHERE workspace_id = ?
				    AND task_id = ?
				    AND attempt_id = ?
				    AND episode_id = ?
				    AND machine_id = ?`,
			)
			.run(input.workspaceId, input.taskId, input.attemptId, input.episodeId, input.machineId);
	}

	async heartbeat(input: EpisodeHeartbeatInput): Promise<boolean> {
		const heartbeat = this.#db.transaction((value: EpisodeHeartbeatInput): boolean => {
			const now = this.#now();
			const result = this.#db
				.prepare(
					`INSERT INTO workflow_episode_heartbeats(episode_id, machine_id, heartbeat_at)
					VALUES (?, ?, ?)
					ON CONFLICT(episode_id) DO UPDATE SET
						machine_id = excluded.machine_id,
						heartbeat_at = excluded.heartbeat_at`,
				)
				.run(value.episodeId, value.machineId, now);
			this.#db
				.prepare(
					`UPDATE workflow_workspace_leases
					    SET expires_at = ? + lease_ms,
					        updated_at = ?
					  WHERE episode_id = ? AND machine_id = ?`,
				)
				.run(now, now, value.episodeId, value.machineId);
			return result.changes === 1;
		});
		return heartbeat.immediate(input);
	}

	async getTask(taskId: string): Promise<WorkflowTaskRecord | null> {
		const row = this.#db
			.prepare<TaskRow, [string]>(
				`SELECT task_id, repo_id, phase, version, state, updated_at
				   FROM workflow_tasks
				  WHERE task_id = ?`,
			)
			.get(taskId);
		return row ? taskRecord(row) : null;
	}

	async getRecovery(taskId: string): Promise<WorkflowRecoveryRecord | null> {
		const task = await this.getTask(taskId);
		if (!task) return null;
		const checkpoint = this.#db
			.prepare<PayloadRow, [string]>(
				`SELECT payload
				   FROM workflow_events
				  WHERE task_id = ? AND path = '/v1/checkpoints'
				  ORDER BY event_id DESC
				  LIMIT 1`,
			)
			.get(taskId);
		const episode = this.#db
			.prepare<PayloadRow, [string]>(
				`SELECT payload
				   FROM workflow_events
				  WHERE task_id = ? AND path = '/v1/episodes'
				  ORDER BY event_id DESC
				  LIMIT 1`,
			)
			.get(taskId);
		return {
			task,
			latestCheckpoint: checkpoint ? recordFromJson(checkpoint.payload) : null,
			lastEpisode: episode ? recordFromJson(episode.payload) : null,
		};
	}

	async close(): Promise<void> {
		this.#db.close();
	}
}
