import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface LocalZZWorkflowEventInput {
	id: string;
	taskId: string;
	repoId?: string;
	kind: string;
	payload: Record<string, unknown>;
}

export interface LocalZZWorkflowEventResult {
	version: number;
}

export interface LocalWorkspaceLeaseInput {
	workspaceId: string;
	taskId: string;
	attemptId: string;
	episodeId: string;
	leaseMs: number;
}

export interface LocalZZWorkflowTaskRecord {
	taskId: string;
	repoId: string | null;
	phase: string | null;
	version: number;
	state: Record<string, unknown>;
	updatedAt: string;
}

export interface LocalZZWorkflowRecoveryRecord {
	task: LocalZZWorkflowTaskRecord;
	latestCheckpoint: Record<string, unknown> | null;
	lastEpisode: Record<string, unknown> | null;
}

export class WorkspaceLeaseConflictError extends Error {
	constructor(readonly workspaceId: string) {
		super(`workspace ${workspaceId} is leased by another local task episode`);
		this.name = "WorkspaceLeaseConflictError";
	}
}

interface ZZWorkflowStoreOptions {
	now?: () => number;
}

export interface RepositoryZZWorkflowStore {
	store: ZZWorkflowStore;
	databasePath: string;
	source: "repository" | "legacy-active";
	migration: LegacyWorkflowMigrationResult;
}

export type LegacyWorkflowMigrationResult =
	| "already-migrated"
	| "deferred-active-lease"
	| "legacy-not-found"
	| "migrated";

interface EventVersionRow {
	resulting_version: number;
}

interface ZZWorkflowEventMigrationRow {
	event_key: string;
	task_id: string;
	kind: string;
	resulting_version: number;
	payload_json: string;
	created_at: number;
}

interface WorkspaceLeaseMigrationRow {
	workspace_id: string;
	task_id: string;
	attempt_id: string;
	episode_id: string;
	lease_ms: number;
	expires_at: number;
	updated_at: number;
}

interface EpisodeHeartbeatMigrationRow {
	episode_id: string;
	heartbeat_at: number;
}

interface VersionRow {
	version: number;
}

interface TaskRow {
	task_id: string;
	repo_id: string | null;
	phase: string | null;
	version: number;
	state_json: string;
	updated_at: number;
}

interface PayloadRow {
	payload_json: string;
}

interface MetadataRow {
	value: string;
}

interface LegacyMigrationSnapshot {
	tasks: TaskRow[];
	events: ZZWorkflowEventMigrationRow[];
	leases: WorkspaceLeaseMigrationRow[];
	heartbeats: EpisodeHeartbeatMigrationRow[];
}

const LEGACY_MIGRATION_KEY = "legacy-global-workflow-v1";

function recordFromJson(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("local ZZWorkflow registry contains a non-object JSON payload");
	}
	return parsed as Record<string, unknown>;
}

function taskRecord(row: TaskRow): LocalZZWorkflowTaskRecord {
	return {
		taskId: row.task_id,
		repoId: row.repo_id,
		phase: row.phase,
		version: row.version,
		state: recordFromJson(row.state_json),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

export function defaultZZWorkflowDbPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "workflow.db");
}

function repositoryDirectoryName(repositoryId: string): string {
	const normalized = repositoryId.trim();
	if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) return normalized;
	const slug = normalized
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 80);
	const hash = Bun.hash(normalized).toString(16).padStart(16, "0");
	return `${slug || "repository"}-${hash}`;
}

export function repositoryZZWorkflowDbPath(repositoryId: string, agentDir = getAgentDir()): string {
	return path.join(agentDir, "workflows", repositoryDirectoryName(repositoryId), "workflow.db");
}

export function openRepositoryZZWorkflowStore(
	repositoryId: string,
	agentDir = getAgentDir(),
	options: ZZWorkflowStoreOptions = {},
): RepositoryZZWorkflowStore {
	const databasePath = repositoryZZWorkflowDbPath(repositoryId, agentDir);
	const repositoryStore = new ZZWorkflowStore(databasePath, options);
	const migration = repositoryStore.migrateLegacyRepository(defaultZZWorkflowDbPath(agentDir), repositoryId);
	if (migration !== "deferred-active-lease") {
		return {
			store: repositoryStore,
			databasePath,
			source: "repository",
			migration,
		};
	}

	repositoryStore.close();
	const legacyPath = defaultZZWorkflowDbPath(agentDir);
	return {
		store: new ZZWorkflowStore(legacyPath, options),
		databasePath: legacyPath,
		source: "legacy-active",
		migration,
	};
}

export class ZZWorkflowStore {
	readonly #db: Database;
	readonly #now: () => number;

	constructor(dbPath = defaultZZWorkflowDbPath(), options: ZZWorkflowStoreOptions = {}) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath, { create: true, strict: true });
		this.#now = options.now ?? Date.now;
		this.#db.exec("PRAGMA busy_timeout = 5000");
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS workflow_tasks (
				task_id TEXT PRIMARY KEY,
				repo_id TEXT,
				phase TEXT,
				version INTEGER NOT NULL DEFAULT 0,
				state_json TEXT NOT NULL DEFAULT '{}',
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS workflow_events (
				event_id INTEGER PRIMARY KEY AUTOINCREMENT,
				event_key TEXT NOT NULL UNIQUE,
				task_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				resulting_version INTEGER NOT NULL,
				payload_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS workflow_events_task_created
				ON workflow_events(task_id, event_id DESC);
			CREATE TABLE IF NOT EXISTS workflow_workspace_leases (
				workspace_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				episode_id TEXT NOT NULL,
				lease_ms INTEGER NOT NULL DEFAULT 90000,
				expires_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS workflow_episode_heartbeats (
				episode_id TEXT PRIMARY KEY,
				heartbeat_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS workflow_metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			DROP TABLE IF EXISTS coordinator_outbox;
			DROP TABLE IF EXISTS coordinator_versions;
			DROP TABLE IF EXISTS memory_outbox;
		`);
	}

	migrateLegacyRepository(legacyPath: string, repositoryId: string): LegacyWorkflowMigrationResult {
		const migration = this.#db
			.prepare<MetadataRow, [string]>("SELECT value FROM workflow_metadata WHERE key = ?")
			.get(LEGACY_MIGRATION_KEY);
		const previouslyMigrated = migration?.value === repositoryId;
		if (!fs.existsSync(legacyPath)) return "legacy-not-found";

		const legacy = new Database(legacyPath, { readonly: true, strict: true });
		try {
			const hasWorkflowTasks = legacy
				.prepare<{ present: number }, []>(
					"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_tasks'",
				)
				.get();
			if (!hasWorkflowTasks) {
				this.#markLegacyMigration(repositoryId);
				return "migrated";
			}

			const activeLease = legacy
				.prepare<{ active: number }, [string, number]>(
					`SELECT 1 AS active
					   FROM workflow_workspace_leases AS lease
					   JOIN workflow_tasks AS task ON task.task_id = lease.task_id
					  WHERE task.repo_id = ? AND lease.expires_at > ?
					  LIMIT 1`,
				)
				.get(repositoryId, this.#now());
			if (activeLease) return "deferred-active-lease";

			const snapshot = this.#readLegacySnapshot(legacy, repositoryId);
			this.#applyLegacySnapshot(snapshot, repositoryId);
			return previouslyMigrated ? "already-migrated" : "migrated";
		} finally {
			legacy.close();
		}
	}

	#readLegacySnapshot(legacy: Database, repositoryId: string): LegacyMigrationSnapshot {
		const tasks = legacy
			.prepare<TaskRow, [string]>(
				`SELECT task_id, repo_id, phase, version, state_json, updated_at
				   FROM workflow_tasks
				  WHERE repo_id = ?
				  ORDER BY updated_at`,
			)
			.all(repositoryId);
		const events = legacy
			.prepare<ZZWorkflowEventMigrationRow, [string]>(
				`SELECT event.event_key,
				        event.task_id,
				        event.kind,
				        event.resulting_version,
				        event.payload_json,
				        event.created_at
				   FROM workflow_events AS event
				   JOIN workflow_tasks AS task ON task.task_id = event.task_id
				  WHERE task.repo_id = ?
				  ORDER BY event.event_id`,
			)
			.all(repositoryId);
		const leases = legacy
			.prepare<WorkspaceLeaseMigrationRow, [string]>(
				`SELECT lease.workspace_id,
				        lease.task_id,
				        lease.attempt_id,
				        lease.episode_id,
				        lease.lease_ms,
				        lease.expires_at,
				        lease.updated_at
				   FROM workflow_workspace_leases AS lease
				   JOIN workflow_tasks AS task ON task.task_id = lease.task_id
				  WHERE task.repo_id = ?`,
			)
			.all(repositoryId);
		const heartbeats = legacy
			.prepare<EpisodeHeartbeatMigrationRow, [string]>(
				`SELECT heartbeat.episode_id, heartbeat.heartbeat_at
				   FROM workflow_episode_heartbeats AS heartbeat
				   JOIN workflow_workspace_leases AS lease ON lease.episode_id = heartbeat.episode_id
				   JOIN workflow_tasks AS task ON task.task_id = lease.task_id
				  WHERE task.repo_id = ?`,
			)
			.all(repositoryId);
		return { tasks, events, leases, heartbeats };
	}

	#applyLegacySnapshot(snapshot: LegacyMigrationSnapshot, repositoryId: string): void {
		const migrate = this.#db.transaction((data: LegacyMigrationSnapshot): void => {
			const insertTask = this.#db.prepare(
				`INSERT INTO workflow_tasks(task_id, repo_id, phase, version, state_json, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(task_id) DO UPDATE SET
					repo_id = excluded.repo_id,
					phase = excluded.phase,
					version = excluded.version,
					state_json = excluded.state_json,
					updated_at = excluded.updated_at
				 WHERE excluded.version > workflow_tasks.version`,
			);
			for (const row of data.tasks) {
				insertTask.run(row.task_id, row.repo_id, row.phase, row.version, row.state_json, row.updated_at);
			}

			const insertEvent = this.#db.prepare(
				`INSERT OR IGNORE INTO workflow_events(
					event_key, task_id, kind, resulting_version, payload_json, created_at
				 ) VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const row of data.events) {
				insertEvent.run(
					row.event_key,
					row.task_id,
					row.kind,
					row.resulting_version,
					row.payload_json,
					row.created_at,
				);
			}

			const insertLease = this.#db.prepare(
				`INSERT INTO workflow_workspace_leases(
					workspace_id, task_id, attempt_id, episode_id, lease_ms, expires_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(workspace_id) DO UPDATE SET
					task_id = excluded.task_id,
					attempt_id = excluded.attempt_id,
					episode_id = excluded.episode_id,
					lease_ms = excluded.lease_ms,
					expires_at = excluded.expires_at,
					updated_at = excluded.updated_at
				 WHERE excluded.updated_at > workflow_workspace_leases.updated_at`,
			);
			for (const row of data.leases) {
				insertLease.run(
					row.workspace_id,
					row.task_id,
					row.attempt_id,
					row.episode_id,
					row.lease_ms,
					row.expires_at,
					row.updated_at,
				);
			}

			const insertHeartbeat = this.#db.prepare(
				`INSERT INTO workflow_episode_heartbeats(episode_id, heartbeat_at)
				 VALUES (?, ?)
				 ON CONFLICT(episode_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at
				 WHERE excluded.heartbeat_at > workflow_episode_heartbeats.heartbeat_at`,
			);
			for (const row of data.heartbeats) insertHeartbeat.run(row.episode_id, row.heartbeat_at);

			this.#db
				.prepare("INSERT OR REPLACE INTO workflow_metadata(key, value) VALUES (?, ?)")
				.run(LEGACY_MIGRATION_KEY, repositoryId);
		});
		migrate.immediate(snapshot);
	}

	#markLegacyMigration(repositoryId: string): void {
		this.#db
			.prepare("INSERT OR REPLACE INTO workflow_metadata(key, value) VALUES (?, ?)")
			.run(LEGACY_MIGRATION_KEY, repositoryId);
	}

	recordEvent(input: LocalZZWorkflowEventInput): LocalZZWorkflowEventResult {
		const apply = this.#db.transaction((event: LocalZZWorkflowEventInput): LocalZZWorkflowEventResult => {
			const existing = this.#db
				.prepare<EventVersionRow, [string]>("SELECT resulting_version FROM workflow_events WHERE event_key = ?")
				.get(event.id);
			if (existing) return { version: existing.resulting_version };

			const now = this.#now();
			this.#db
				.prepare("INSERT OR IGNORE INTO workflow_tasks(task_id, updated_at) VALUES (?, ?)")
				.run(event.taskId, now);
			const row = this.#db
				.prepare<VersionRow, [string]>("SELECT version FROM workflow_tasks WHERE task_id = ?")
				.get(event.taskId);
			const version = (row?.version ?? 0) + 1;
			const state = event.payload.state;
			const stateRecord =
				state !== null && typeof state === "object" && !Array.isArray(state)
					? (state as Record<string, unknown>)
					: undefined;
			const phase = typeof stateRecord?.phase === "string" ? stateRecord.phase : null;
			this.#db
				.prepare(
					`UPDATE workflow_tasks
					    SET version = ?,
					        repo_id = COALESCE(?, repo_id),
					        phase = COALESCE(?, phase),
					        state_json = CASE WHEN ? = 1 THEN ? ELSE state_json END,
					        updated_at = ?
					  WHERE task_id = ?`,
				)
				.run(
					version,
					event.repoId ?? null,
					phase,
					stateRecord ? 1 : 0,
					JSON.stringify(stateRecord ?? {}),
					now,
					event.taskId,
				);
			this.#db
				.prepare(
					`INSERT INTO workflow_events(event_key, task_id, kind, resulting_version, payload_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(event.id, event.taskId, event.kind, version, JSON.stringify(event.payload), now);
			return { version };
		});
		return apply.immediate(input);
	}

	acquireLease(input: LocalWorkspaceLeaseInput): boolean {
		const now = this.#now();
		const result = this.#db
			.prepare(
				`INSERT INTO workflow_workspace_leases(
					workspace_id, task_id, attempt_id, episode_id, lease_ms, expires_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(workspace_id) DO UPDATE SET
					task_id = excluded.task_id,
					attempt_id = excluded.attempt_id,
					episode_id = excluded.episode_id,
					lease_ms = excluded.lease_ms,
					expires_at = excluded.expires_at,
					updated_at = excluded.updated_at
				WHERE workflow_workspace_leases.expires_at <= ?
				   OR (
						workflow_workspace_leases.task_id = excluded.task_id
					AND workflow_workspace_leases.attempt_id = excluded.attempt_id
					AND workflow_workspace_leases.episode_id = excluded.episode_id
				   )`,
			)
			.run(
				input.workspaceId,
				input.taskId,
				input.attemptId,
				input.episodeId,
				input.leaseMs,
				now + input.leaseMs,
				now,
				now,
			);
		return result.changes === 1;
	}

	releaseLease(input: LocalWorkspaceLeaseInput): void {
		const release = this.#db.transaction((lease: LocalWorkspaceLeaseInput): void => {
			const result = this.#db
				.prepare(
					`DELETE FROM workflow_workspace_leases
					  WHERE workspace_id = ?
					    AND task_id = ?
					    AND attempt_id = ?
					    AND episode_id = ?`,
				)
				.run(lease.workspaceId, lease.taskId, lease.attemptId, lease.episodeId);
			if (result.changes === 1) {
				this.#db.prepare("DELETE FROM workflow_episode_heartbeats WHERE episode_id = ?").run(lease.episodeId);
			}
		});
		release.immediate(input);
	}

	heartbeat(episodeId: string): boolean {
		const heartbeat = this.#db.transaction((value: string): boolean => {
			const now = this.#now();
			const lease = this.#db
				.prepare(
					`UPDATE workflow_workspace_leases
					    SET expires_at = ? + lease_ms,
					        updated_at = ?
					  WHERE episode_id = ?
					    AND expires_at > ?`,
				)
				.run(now, now, value, now);
			if (lease.changes !== 1) return false;
			this.#db
				.prepare(
					`INSERT INTO workflow_episode_heartbeats(episode_id, heartbeat_at)
					 VALUES (?, ?)
					 ON CONFLICT(episode_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
				)
				.run(value, now);
			return true;
		});
		return heartbeat.immediate(episodeId);
	}

	getTask(taskId: string): LocalZZWorkflowTaskRecord | null {
		const row = this.#db
			.prepare<TaskRow, [string]>(
				`SELECT task_id, repo_id, phase, version, state_json, updated_at
				   FROM workflow_tasks
				  WHERE task_id = ?`,
			)
			.get(taskId);
		return row ? taskRecord(row) : null;
	}

	getRecovery(taskId: string): LocalZZWorkflowRecoveryRecord | null {
		const task = this.getTask(taskId);
		if (!task) return null;
		const checkpoint = this.#db
			.prepare<PayloadRow, [string]>(
				`SELECT payload_json
				   FROM workflow_events
				  WHERE task_id = ? AND kind = 'checkpoint'
				  ORDER BY event_id DESC
				  LIMIT 1`,
			)
			.get(taskId);
		const episode = this.#db
			.prepare<PayloadRow, [string]>(
				`SELECT payload_json
				   FROM workflow_events
				  WHERE task_id = ? AND kind = 'episode-started'
				  ORDER BY event_id DESC
				  LIMIT 1`,
			)
			.get(taskId);
		return {
			task,
			latestCheckpoint: checkpoint ? recordFromJson(checkpoint.payload_json) : null,
			lastEpisode: episode ? recordFromJson(episode.payload_json) : null,
		};
	}

	close(): void {
		this.#db.close();
	}
}
