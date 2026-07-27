import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	KnowledgeBankProfileStatus,
	KnowledgeBankRef,
	KnowledgeRequestContext,
	KnowledgeRetainGroup,
	KnowledgeReviewRequest,
	KnowledgeWorkingSet,
} from "./types";

export interface KnowledgeOutboxItem {
	id: string;
	bankId: string;
	documentId: string;
	contentHash: string;
	request: Record<string, unknown>;
	attempts: number;
	groupId?: string;
	memberId?: string;
}

export interface KnowledgeGroupMember {
	id: string;
	groupId: string;
	bankId: string;
	documentId: string;
	knowledgeKey: string;
	status: "queued" | "completed" | "failed" | "invalidated" | "purged";
	classification: Record<string, unknown>;
}

export interface EnqueueKnowledgeInput extends Omit<KnowledgeOutboxItem, "attempts"> {
	requestContext: KnowledgeRequestContext;
	repoId: string;
	taskId?: string;
	knowledgeKey: string;
	classification: Record<string, unknown>;
}

interface OutboxRow {
	id: string;
	bank_id: string;
	document_id: string;
	content_hash: string;
	request_json: string;
	attempts: number;
	group_id: string | null;
	member_id: string | null;
}

interface GroupRow {
	id: string;
	origin: KnowledgeRetainGroup["origin"];
	source_request_id: string | null;
	user_message_entry_id: string | null;
	bank_id: string;
	repo_id: string;
	task_id: string | null;
	status: KnowledgeRetainGroup["status"];
	member_count: number;
	queued_count: number;
	failed_count: number;
	created_at: string;
	completed_at: string | null;
}

interface GroupMemberRow {
	id: string;
	group_id: string;
	bank_id: string;
	document_id: string;
	knowledge_key: string;
	status: KnowledgeGroupMember["status"];
	classification_json: string;
}

interface BankProfileRow {
	profile_name: string;
	profile_version: number;
	desired_hash: string;
	applied_hash: string | null;
	drifted: number;
	managed_config_mode: KnowledgeBankProfileStatus["managedConfigMode"];
}

interface JsonRow {
	payload_json: string;
}

interface CountRow {
	count: number;
}

interface ColumnRow {
	name: string;
}

function retryAt(attempts: number): string {
	const seconds = Math.min(300, 2 ** Math.min(attempts, 8));
	return new Date(Date.now() + seconds * 1_000).toISOString();
}

function parseObject(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (!isRecord(parsed)) throw new Error("ZZ knowledge database contains an invalid object payload");
	return parsed;
}

export function knowledgeDbPath(agentDir: string, securityBoundary: string): string {
	const hash = Bun.hash(securityBoundary).toString(16).padStart(16, "0");
	return path.join(agentDir, "knowledge", `boundary-${hash}`, "knowledge.db");
}

export function registerKnowledgeBank(
	agentDir: string,
	userId: string,
	securityBoundary: string,
	bank: KnowledgeBankRef,
	maxBanksPerUser: number,
): void {
	const databasePath = path.join(agentDir, "knowledge", "banks.db");
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { create: true, strict: true });
	try {
		database.exec("PRAGMA busy_timeout = 5000");
		database.exec("PRAGMA journal_mode = WAL");
		database.exec(`
			CREATE TABLE IF NOT EXISTS knowledge_bank_catalog_v2 (
				bank_id TEXT PRIMARY KEY,
				user_hash TEXT NOT NULL,
				boundary_hash TEXT NOT NULL,
				bank_kind TEXT NOT NULL,
				repository_hash TEXT NOT NULL,
				display_name TEXT NOT NULL,
				name_source TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(user_hash, boundary_hash, bank_kind, repository_hash)
			);
			CREATE INDEX IF NOT EXISTS knowledge_bank_catalog_v2_user
				ON knowledge_bank_catalog_v2(user_hash, created_at);
		`);
		const userHash = Bun.hash(userId).toString(16).padStart(16, "0");
		const boundaryHash = Bun.hash(securityBoundary).toString(16).padStart(16, "0");
		const repositoryHash = bank.repositoryId ? Bun.hash(bank.repositoryId).toString(16).padStart(16, "0") : "";
		database.transaction(() => {
			const existing = database
				.prepare<{ bank_id: string }, [string]>("SELECT bank_id FROM knowledge_bank_catalog_v2 WHERE bank_id = ?")
				.get(bank.bankId);
			const now = new Date().toISOString();
			if (existing) {
				database
					.prepare(
						"UPDATE knowledge_bank_catalog_v2 SET display_name = ?, name_source = ?, updated_at = ? WHERE bank_id = ?",
					)
					.run(bank.displayName, bank.nameSource, now, bank.bankId);
				return;
			}
			const boundaryExists =
				(database
					.prepare<CountRow, [string, string]>(
						"SELECT COUNT(*) AS count FROM knowledge_bank_catalog_v2 WHERE user_hash = ? AND boundary_hash = ?",
					)
					.get(userHash, boundaryHash)?.count ?? 0) > 0;
			const securityBoundaryCount =
				database
					.prepare<CountRow, [string]>(
						"SELECT COUNT(DISTINCT boundary_hash) AS count FROM knowledge_bank_catalog_v2 WHERE user_hash = ?",
					)
					.get(userHash)?.count ?? 0;
			if (!boundaryExists && securityBoundaryCount >= maxBanksPerUser) {
				throw new Error(
					`ZZ Knowledge security-boundary limit reached for this user (${securityBoundaryCount}/${maxBanksPerUser}); reuse or remove a security boundary`,
				);
			}
			database
				.prepare(
					`INSERT INTO knowledge_bank_catalog_v2(
						bank_id, user_hash, boundary_hash, bank_kind, repository_hash,
						display_name, name_source, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					bank.bankId,
					userHash,
					boundaryHash,
					bank.kind,
					repositoryHash,
					bank.displayName,
					bank.nameSource,
					now,
					now,
				);
		})();
	} finally {
		database.close();
	}
}

export class KnowledgeStore {
	readonly #db: Database;

	constructor(databasePath: string) {
		fs.mkdirSync(path.dirname(databasePath), { recursive: true });
		this.#db = new Database(databasePath, { create: true, strict: true });
		this.#db.exec("PRAGMA busy_timeout = 5000");
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS knowledge_outbox (
				id TEXT PRIMARY KEY,
				bank_id TEXT NOT NULL,
				document_id TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				request_json TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'queued',
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TEXT,
				created_at TEXT NOT NULL,
				delivered_at TEXT,
				group_id TEXT,
				member_id TEXT,
				UNIQUE(bank_id, document_id, content_hash)
			);
			CREATE INDEX IF NOT EXISTS knowledge_outbox_pending
				ON knowledge_outbox(status, next_attempt_at, created_at);

			CREATE TABLE IF NOT EXISTS knowledge_retain_groups (
				id TEXT PRIMARY KEY,
				origin TEXT NOT NULL,
				source_request_id TEXT,
				user_message_entry_id TEXT,
				bank_id TEXT NOT NULL,
				repo_id TEXT NOT NULL,
				task_id TEXT,
				status TEXT NOT NULL DEFAULT 'prepared',
				created_at TEXT NOT NULL,
				completed_at TEXT
			);
			CREATE INDEX IF NOT EXISTS knowledge_retain_groups_repo
				ON knowledge_retain_groups(repo_id, created_at);

			CREATE TABLE IF NOT EXISTS knowledge_retain_group_members (
				id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL REFERENCES knowledge_retain_groups(id),
				document_id TEXT NOT NULL,
				knowledge_key TEXT NOT NULL,
				classification_json TEXT NOT NULL,
				outbox_id TEXT REFERENCES knowledge_outbox(id),
				status TEXT NOT NULL DEFAULT 'queued',
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(group_id, document_id)
			);
			CREATE INDEX IF NOT EXISTS knowledge_group_members_group
				ON knowledge_retain_group_members(group_id, status);

			CREATE TABLE IF NOT EXISTS knowledge_bank_profiles (
				bank_id TEXT PRIMARY KEY,
				profile_name TEXT NOT NULL,
				profile_version INTEGER NOT NULL,
				desired_hash TEXT NOT NULL,
				applied_hash TEXT,
				drifted INTEGER NOT NULL DEFAULT 0,
				managed_config_mode TEXT NOT NULL,
				checked_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS knowledge_working_sets (
				cache_key TEXT PRIMARY KEY,
				repo_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS knowledge_working_sets_repo
				ON knowledge_working_sets(repo_id, expires_at);

			CREATE TABLE IF NOT EXISTS knowledge_reviews (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				repo_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				created_at TEXT NOT NULL,
				resolved_at TEXT
			);
			CREATE INDEX IF NOT EXISTS knowledge_reviews_pending
				ON knowledge_reviews(status, repo_id, created_at);
		`);
		this.#ensureColumn("knowledge_outbox", "group_id", "TEXT");
		this.#ensureColumn("knowledge_outbox", "member_id", "TEXT");
		this.#ensureColumn("knowledge_retain_group_members", "bank_id", "TEXT");
		this.#db.exec(`
			UPDATE knowledge_retain_group_members
			   SET bank_id = (
				SELECT bank_id FROM knowledge_retain_groups
				 WHERE knowledge_retain_groups.id = knowledge_retain_group_members.group_id
			   )
			 WHERE bank_id IS NULL
		`);
	}

	#ensureColumn(table: string, column: string, definition: string): void {
		const columns = this.#db.query<ColumnRow, []>(`PRAGMA table_info(${table})`).all();
		if (columns.some(value => value.name === column)) return;
		this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}

	enqueue(input: EnqueueKnowledgeInput): boolean {
		const now = new Date().toISOString();
		let inserted = false;
		this.#db.transaction(() => {
			this.#db
				.prepare(
					`INSERT OR IGNORE INTO knowledge_retain_groups(
						id, origin, source_request_id, user_message_entry_id,
						bank_id, repo_id, task_id, status, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
				)
				.run(
					input.requestContext.groupId,
					input.requestContext.origin,
					input.requestContext.sourceRequestId ?? null,
					input.requestContext.userMessageEntryId ?? null,
					input.bankId,
					input.repoId,
					input.taskId ?? null,
					now,
				);
			const result = this.#db
				.prepare(
					`INSERT OR IGNORE INTO knowledge_outbox(
						id, bank_id, document_id, content_hash, request_json,
						created_at, group_id, member_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.id,
					input.bankId,
					input.documentId,
					input.contentHash,
					JSON.stringify(input.request),
					now,
					input.requestContext.groupId,
					input.memberId ?? null,
				);
			inserted = result.changes === 1;
			if (!inserted || !input.memberId) return;
			this.#db
				.prepare(
					`INSERT INTO knowledge_retain_group_members(
						id, group_id, bank_id, document_id, knowledge_key, classification_json,
						outbox_id, status, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
				)
				.run(
					input.memberId,
					input.requestContext.groupId,
					input.bankId,
					input.documentId,
					input.knowledgeKey,
					JSON.stringify(input.classification),
					input.id,
					now,
					now,
				);
			this.#db
				.prepare("UPDATE knowledge_retain_groups SET status = 'queued', completed_at = NULL WHERE id = ?")
				.run(input.requestContext.groupId);
		})();
		return inserted;
	}

	pending(limit = 50): KnowledgeOutboxItem[] {
		const rows = this.#db
			.prepare<OutboxRow, [string, number]>(
				`SELECT id, bank_id, document_id, content_hash, request_json, attempts, group_id, member_id
				   FROM knowledge_outbox
				  WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
				  ORDER BY created_at
				  LIMIT ?`,
			)
			.all(new Date().toISOString(), limit);
		return rows.map(row => ({
			id: row.id,
			bankId: row.bank_id,
			documentId: row.document_id,
			contentHash: row.content_hash,
			request: parseObject(row.request_json),
			attempts: row.attempts,
			groupId: row.group_id ?? undefined,
			memberId: row.member_id ?? undefined,
		}));
	}

	markDelivered(id: string, groupId?: string, memberId?: string): void {
		const now = new Date().toISOString();
		this.#db.transaction(() => {
			this.#db
				.prepare(
					"UPDATE knowledge_outbox SET status = 'delivered', delivered_at = ?, next_attempt_at = NULL WHERE id = ?",
				)
				.run(now, id);
			if (memberId) {
				this.#db
					.prepare(
						"UPDATE knowledge_retain_group_members SET status = 'completed', last_error = NULL, updated_at = ? WHERE id = ?",
					)
					.run(now, memberId);
			}
			if (groupId) this.#refreshGroupStatus(groupId, now);
		})();
	}

	markRetry(
		id: string,
		attempts: number,
		retryMax: number,
		groupId?: string,
		memberId?: string,
		error?: string,
	): void {
		const nextAttempts = attempts + 1;
		const failed = nextAttempts >= retryMax;
		const now = new Date().toISOString();
		this.#db.transaction(() => {
			this.#db
				.prepare("UPDATE knowledge_outbox SET status = ?, attempts = ?, next_attempt_at = ? WHERE id = ?")
				.run(failed ? "failed" : "queued", nextAttempts, retryAt(nextAttempts), id);
			if (memberId) {
				this.#db
					.prepare(
						"UPDATE knowledge_retain_group_members SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
					)
					.run(failed ? "failed" : "queued", error ?? null, now, memberId);
			}
			if (groupId) this.#refreshGroupStatus(groupId, now);
		})();
	}

	#refreshGroupStatus(groupId: string, now: string): void {
		const counts = this.#db
			.prepare<{ total: number; queued: number; failed: number; completed: number }, [string]>(
				`SELECT COUNT(*) AS total,
					SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
					SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
				   FROM knowledge_retain_group_members WHERE group_id = ?`,
			)
			.get(groupId);
		if (!counts || counts.total === 0) return;
		const status =
			counts.completed === counts.total
				? "completed"
				: counts.failed === counts.total
					? "failed"
					: counts.failed > 0 || counts.completed > 0
						? "partial"
						: "queued";
		this.#db
			.prepare("UPDATE knowledge_retain_groups SET status = ?, completed_at = ? WHERE id = ?")
			.run(status, status === "completed" ? now : null, groupId);
	}

	listGroups(repoId: string, limit = 50): KnowledgeRetainGroup[] {
		const rows = this.#db
			.prepare<GroupRow, [string, number]>(
				`SELECT g.id, g.origin, g.source_request_id, g.user_message_entry_id,
						g.bank_id, g.repo_id, g.task_id, g.status, g.created_at, g.completed_at,
						COUNT(m.id) AS member_count,
						SUM(CASE WHEN m.status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
						SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
				   FROM knowledge_retain_groups g
				   LEFT JOIN knowledge_retain_group_members m ON m.group_id = g.id
				  WHERE g.repo_id = ?
				  GROUP BY g.id
				  ORDER BY g.created_at DESC
				  LIMIT ?`,
			)
			.all(repoId, limit);
		return rows.map(row => ({
			id: row.id,
			origin: row.origin,
			sourceRequestId: row.source_request_id ?? undefined,
			userMessageEntryId: row.user_message_entry_id ?? undefined,
			bankId: row.bank_id,
			repoId: row.repo_id,
			taskId: row.task_id ?? undefined,
			status: row.status,
			memberCount: row.member_count,
			queuedCount: row.queued_count ?? 0,
			failedCount: row.failed_count ?? 0,
			createdAt: row.created_at,
			completedAt: row.completed_at ?? undefined,
		}));
	}

	groupMembers(groupId: string): KnowledgeGroupMember[] {
		return this.#db
			.prepare<GroupMemberRow, [string]>(
				`SELECT id, group_id, bank_id, document_id, knowledge_key, status, classification_json
				   FROM knowledge_retain_group_members WHERE group_id = ? ORDER BY created_at`,
			)
			.all(groupId)
			.map(row => ({
				id: row.id,
				groupId: row.group_id,
				bankId: row.bank_id,
				documentId: row.document_id,
				knowledgeKey: row.knowledge_key,
				status: row.status,
				classification: parseObject(row.classification_json),
			}));
	}

	setGroupActionStatus(
		groupId: string,
		status: Extract<KnowledgeRetainGroup["status"], "invalidated" | "completed" | "purged">,
	): void {
		const memberStatus = status === "completed" ? "completed" : status;
		const now = new Date().toISOString();
		this.#db.transaction(() => {
			this.#db
				.prepare("UPDATE knowledge_retain_groups SET status = ?, completed_at = ? WHERE id = ?")
				.run(status, status === "completed" ? now : null, groupId);
			this.#db
				.prepare("UPDATE knowledge_retain_group_members SET status = ?, updated_at = ? WHERE group_id = ?")
				.run(memberStatus, now, groupId);
		})();
	}

	groupCount(repoId: string): number {
		return (
			this.#db
				.prepare<CountRow, [string]>("SELECT COUNT(*) AS count FROM knowledge_retain_groups WHERE repo_id = ?")
				.get(repoId)?.count ?? 0
		);
	}

	putBankProfile(bankId: string, status: KnowledgeBankProfileStatus): void {
		this.#db
			.prepare(
				`INSERT OR REPLACE INTO knowledge_bank_profiles(
					bank_id, profile_name, profile_version, desired_hash, applied_hash,
					drifted, managed_config_mode, checked_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				bankId,
				status.name,
				status.version,
				status.hash,
				status.appliedHash ?? null,
				status.drifted ? 1 : 0,
				status.managedConfigMode,
				new Date().toISOString(),
			);
	}

	getBankProfile(bankId: string): KnowledgeBankProfileStatus | undefined {
		const row = this.#db
			.prepare<BankProfileRow, [string]>(
				`SELECT profile_name, profile_version, desired_hash, applied_hash,
						drifted, managed_config_mode
				   FROM knowledge_bank_profiles WHERE bank_id = ?`,
			)
			.get(bankId);
		if (!row) return undefined;
		return {
			name: row.profile_name,
			version: row.profile_version,
			hash: row.desired_hash,
			appliedHash: row.applied_hash ?? undefined,
			drifted: row.drifted === 1,
			managedConfigMode: row.managed_config_mode,
		};
	}

	queuedCount(): number {
		return (
			this.#db.prepare<CountRow, []>("SELECT COUNT(*) AS count FROM knowledge_outbox WHERE status = 'queued'").get()
				?.count ?? 0
		);
	}

	getWorkingSet(cacheKey: string, now = Date.now()): KnowledgeWorkingSet | undefined {
		const row = this.#db
			.prepare<JsonRow, [string, number]>(
				"SELECT payload_json FROM knowledge_working_sets WHERE cache_key = ? AND expires_at > ?",
			)
			.get(cacheKey, now);
		if (!row) return undefined;
		return JSON.parse(row.payload_json) as KnowledgeWorkingSet;
	}

	putWorkingSet(cacheKey: string, repoId: string, value: KnowledgeWorkingSet, expiresAt: number): void {
		this.#db
			.prepare(
				`INSERT OR REPLACE INTO knowledge_working_sets(
					cache_key, repo_id, payload_json, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(cacheKey, repoId, JSON.stringify(value), expiresAt, Date.now());
	}

	addReview(value: KnowledgeReviewRequest): void {
		this.#db
			.prepare(
				`INSERT OR REPLACE INTO knowledge_reviews(
					id, task_id, repo_id, payload_json, status, created_at
				) VALUES (?, ?, ?, ?, 'pending', ?)`,
			)
			.run(value.id, value.taskId, value.repoId, JSON.stringify(value), value.createdAt);
	}

	listReviews(repoId?: string): KnowledgeReviewRequest[] {
		const rows = repoId
			? this.#db
					.prepare<JsonRow, [string]>(
						`SELECT payload_json FROM knowledge_reviews
						  WHERE status = 'pending' AND repo_id = ?
						  ORDER BY created_at`,
					)
					.all(repoId)
			: this.#db
					.prepare<JsonRow, []>(
						"SELECT payload_json FROM knowledge_reviews WHERE status = 'pending' ORDER BY created_at",
					)
					.all();
		return rows.map(row => JSON.parse(row.payload_json) as KnowledgeReviewRequest);
	}

	pendingReviewCount(): number {
		return (
			this.#db
				.prepare<CountRow, []>("SELECT COUNT(*) AS count FROM knowledge_reviews WHERE status = 'pending'")
				.get()?.count ?? 0
		);
	}

	close(): void {
		this.#db.close();
	}
}
