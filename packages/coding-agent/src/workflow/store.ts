import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface MemoryOutboxRequest {
	id: string;
	bankId: string;
	documentId: string;
	contentHash: string;
	request: Record<string, unknown>;
	mutable: boolean;
	attempts: number;
}

export interface CoordinatorOutboxRequest {
	id: string;
	path: string;
	request: Record<string, unknown>;
	attempts: number;
}

interface MemoryOutboxRow {
	id: string;
	bank_id: string;
	document_id: string;
	content_hash: string;
	request_json: string;
	mutable: number;
	attempts: number;
}

interface CoordinatorOutboxRow {
	id: string;
	path: string;
	request_json: string;
	attempts: number;
}

function nowIso(): string {
	return new Date().toISOString();
}

function retryAt(attempts: number): string {
	const seconds = Math.min(300, 2 ** Math.min(attempts, 8));
	return new Date(Date.now() + seconds * 1_000).toISOString();
}

export function defaultWorkflowDbPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "workflow.db");
}

export class WorkflowStore {
	readonly #db: Database;

	constructor(dbPath = defaultWorkflowDbPath()) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath, { create: true, strict: true });
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA busy_timeout = 5000");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS memory_outbox (
				id TEXT PRIMARY KEY,
				bank_id TEXT NOT NULL,
				document_id TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				request_json TEXT NOT NULL,
				mutable INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TEXT,
				created_at TEXT NOT NULL,
				delivered_at TEXT,
				UNIQUE(bank_id, document_id, content_hash)
			);
			CREATE INDEX IF NOT EXISTS memory_outbox_pending
				ON memory_outbox(status, next_attempt_at, created_at);
			CREATE TABLE IF NOT EXISTS coordinator_outbox (
				id TEXT PRIMARY KEY,
				path TEXT NOT NULL,
				request_json TEXT NOT NULL,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TEXT,
				created_at TEXT NOT NULL,
				delivered_at TEXT
			);
			CREATE INDEX IF NOT EXISTS coordinator_outbox_pending
				ON coordinator_outbox(status, next_attempt_at, created_at);
			CREATE TABLE IF NOT EXISTS coordinator_versions (
				task_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL
			);
		`);
	}

	enqueueMemory(input: Omit<MemoryOutboxRequest, "attempts">): void {
		if (input.mutable) {
			this.#db
				.prepare("DELETE FROM memory_outbox WHERE bank_id = ? AND document_id = ? AND status != 'delivered'")
				.run(input.bankId, input.documentId);
		}
		this.#db
			.prepare(
				`INSERT OR IGNORE INTO memory_outbox
					(id, bank_id, document_id, content_hash, request_json, mutable, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
			)
			.run(
				input.id,
				input.bankId,
				input.documentId,
				input.contentHash,
				JSON.stringify(input.request),
				input.mutable ? 1 : 0,
				nowIso(),
			);
	}

	pendingMemory(limit = 50): MemoryOutboxRequest[] {
		return this.#memoryRows(
			`SELECT id, bank_id, document_id, content_hash, request_json, mutable, attempts
			   FROM memory_outbox
			  WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
			  ORDER BY created_at
			  LIMIT ?`,
			[nowIso(), limit],
		);
	}

	queuedMemory(limit = 50): MemoryOutboxRequest[] {
		return this.#memoryRows(
			`SELECT id, bank_id, document_id, content_hash, request_json, mutable, attempts
			   FROM memory_outbox
			  WHERE status = 'queued'
			  ORDER BY created_at
			  LIMIT ?`,
			[limit],
		);
	}

	#memoryRows(query: string, bindings: SQLQueryBindings[]): MemoryOutboxRequest[] {
		const rows = this.#db.prepare<MemoryOutboxRow, SQLQueryBindings[]>(query).all(...bindings);
		return rows.map(row => ({
			id: row.id,
			bankId: row.bank_id,
			documentId: row.document_id,
			contentHash: row.content_hash,
			request: JSON.parse(row.request_json) as Record<string, unknown>,
			mutable: row.mutable === 1,
			attempts: row.attempts,
		}));
	}

	markMemoryDelivered(id: string): void {
		this.#db
			.prepare(
				"UPDATE memory_outbox SET status = 'delivered', delivered_at = ?, next_attempt_at = NULL WHERE id = ?",
			)
			.run(nowIso(), id);
	}

	markMemoryRetry(id: string, attempts: number, retryMax: number): void {
		const nextAttempts = attempts + 1;
		this.#db
			.prepare("UPDATE memory_outbox SET status = ?, attempts = ?, next_attempt_at = ? WHERE id = ?")
			.run(nextAttempts >= retryMax ? "failed" : "queued", nextAttempts, retryAt(nextAttempts), id);
	}

	enqueueCoordinator(input: Omit<CoordinatorOutboxRequest, "attempts">): void {
		this.#db
			.prepare(
				`INSERT OR IGNORE INTO coordinator_outbox
					(id, path, request_json, status, created_at)
				 VALUES (?, ?, ?, 'queued', ?)`,
			)
			.run(input.id, input.path, JSON.stringify(input.request), nowIso());
	}

	pendingCoordinator(limit = 100): CoordinatorOutboxRequest[] {
		const rows = this.#db
			.prepare<CoordinatorOutboxRow, [string, number]>(
				`SELECT id, path, request_json, attempts
				   FROM coordinator_outbox
				  WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
				  ORDER BY created_at
				  LIMIT ?`,
			)
			.all(nowIso(), limit);
		return rows.map(row => ({
			id: row.id,
			path: row.path,
			request: JSON.parse(row.request_json) as Record<string, unknown>,
			attempts: row.attempts,
		}));
	}

	markCoordinatorDelivered(id: string): void {
		this.#db
			.prepare(
				"UPDATE coordinator_outbox SET status = 'delivered', delivered_at = ?, next_attempt_at = NULL WHERE id = ?",
			)
			.run(nowIso(), id);
	}

	markCoordinatorRetry(id: string, attempts: number): void {
		const nextAttempts = attempts + 1;
		this.#db
			.prepare("UPDATE coordinator_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?")
			.run(nextAttempts, retryAt(nextAttempts), id);
	}

	coordinatorVersion(taskId: string): number {
		const row = this.#db
			.prepare<{ version: number }, [string]>("SELECT version FROM coordinator_versions WHERE task_id = ?")
			.get(taskId);
		return row?.version ?? 0;
	}

	setCoordinatorVersion(taskId: string, version: number): void {
		this.#db
			.prepare(
				`INSERT INTO coordinator_versions(task_id, version) VALUES (?, ?)
				 ON CONFLICT(task_id) DO UPDATE SET version = excluded.version`,
			)
			.run(taskId, version);
	}

	close(): void {
		this.#db.close();
	}
}
