import { escapeXmlAttribute, escapeXmlText, isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import workflowMemoryContextPrompt from "../prompts/goals/workflow-memory-context.md" with { type: "text" };
import type { WorkflowStore } from "../workflow/store";
import { ensureBankExists } from "./bank";
import type { HindsightApi, RecallResult, RetainOptions } from "./client";
import type { HindsightConfig } from "./config";

export type DurableMemoryKind =
	| "repo-fact"
	| "decision"
	| "failed-approach"
	| "successful-recipe"
	| "user-preference"
	| "postmortem";

export interface DurableMemoryRecord {
	kind: DurableMemoryKind;
	statement: string;
	rationale?: string;
	applicability: {
		repoId?: string;
		taskId?: string;
		commitRange?: string;
		conditions?: string[];
	};
	evidence: Array<{
		evidenceId: string;
		type: "test" | "log" | "diff" | "user-confirmation";
	}>;
	confidence: "confirmed" | "probable";
	documentId?: string;
	mutable?: boolean;
	attemptId?: string;
	specVersion?: number;
	planVersion?: number;
	commit?: string;
}

export interface MemoryHealth {
	available: boolean;
	queued: number;
	error?: string;
}

export interface MemoryContext {
	content?: string;
	degraded: boolean;
}

export interface MemoryGateway {
	health(): Promise<MemoryHealth>;
	recallForIntake(input: { userId: string; repoId: string; taskDraft: string }): Promise<MemoryContext>;
	recallForPlanning(input: {
		repoId: string;
		taskId: string;
		goal: string;
		changedFiles?: string[];
	}): Promise<MemoryContext>;
	recallForRecovery(input: {
		repoId: string;
		taskId: string;
		attemptId: string;
		failure: string;
	}): Promise<MemoryContext>;
	retain(record: DurableMemoryRecord): Promise<void>;
	replaceCurrentTaskSummary(input: { repoId: string; taskId: string; summary: string }): Promise<void>;
	flushOutbox(): Promise<void>;
}

export interface WorkflowMemoryGatewayOptions {
	client: HindsightApi;
	config: HindsightConfig;
	store: WorkflowStore;
	machineId: string;
	sessionId: string;
	episodeId(): string | undefined;
	redact?(content: string): string;
}

interface QueuedRetainRequest {
	content: string;
	context?: string;
	metadata?: Record<string, string>;
	documentId: string;
	tags?: string[];
	updateMode?: "replace" | "append";
}

const USER_BANK_PREFIX = "zz-user-v1";
const REPO_BANK_PREFIX = "zz-repo-v1";
const banksSet = new Set<string>();

function hash(value: string): string {
	return Bun.hash(value).toString(16).padStart(16, "0");
}

function userBankId(userId: string): string {
	return `${USER_BANK_PREFIX}-${hash(userId)}`;
}

function repoBankId(repoId: string): string {
	return `${REPO_BANK_PREFIX}-${repoId}`;
}

function requestFromRecord(value: unknown): QueuedRetainRequest | undefined {
	if (
		!isRecord(value) ||
		typeof value.content !== "string" ||
		typeof value.documentId !== "string" ||
		(value.context !== undefined && typeof value.context !== "string") ||
		(value.updateMode !== undefined && value.updateMode !== "replace" && value.updateMode !== "append")
	) {
		return undefined;
	}
	const metadata = isRecord(value.metadata)
		? Object.fromEntries(
				Object.entries(value.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			)
		: undefined;
	const tags = Array.isArray(value.tags)
		? value.tags.filter((tag): tag is string => typeof tag === "string")
		: undefined;
	return {
		content: value.content,
		context: value.context,
		metadata,
		documentId: value.documentId,
		tags,
		updateMode: value.updateMode,
	};
}

function memoryItems(results: RecallResult[]): Array<{ evidence: string; text: string }> {
	const seen = new Set<string>();
	const items: Array<{ evidence: string; text: string }> = [];
	for (const result of results) {
		const text = result.text.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		items.push({
			evidence: escapeXmlAttribute(`memory:${result.id ?? hash(text)}`),
			text: escapeXmlText(text),
		});
	}
	return items;
}

export class WorkflowMemoryGateway implements MemoryGateway {
	readonly #client: HindsightApi;
	readonly #config: HindsightConfig;
	readonly #store: WorkflowStore;
	readonly #machineId: string;
	readonly #sessionId: string;
	readonly #episodeId: () => string | undefined;
	readonly #redact?: (content: string) => string;
	#flushPromise: Promise<void> | undefined;

	constructor(options: WorkflowMemoryGatewayOptions) {
		this.#client = options.client;
		this.#config = options.config;
		this.#store = options.store;
		this.#machineId = options.machineId;
		this.#sessionId = options.sessionId;
		this.#episodeId = options.episodeId;
		this.#redact = options.redact;
	}

	async health(): Promise<MemoryHealth> {
		try {
			const bankId = userBankId(this.#config.userId ?? "default");
			await ensureBankExists(this.#client, bankId, this.#config, banksSet);
			await this.#client.listMemories(bankId, { limit: 1 });
			return { available: true, queued: this.#store.queuedMemory().length };
		} catch (error) {
			return { available: false, queued: this.#store.queuedMemory().length, error: String(error) };
		}
	}

	async #recall(query: string, input: { repoId: string; taskId?: string; userId?: string }): Promise<MemoryContext> {
		const taskTags = input.taskId ? [`repo:${input.repoId}`, `task:${input.taskId}`] : undefined;
		try {
			await ensureBankExists(this.#client, repoBankId(input.repoId), this.#config, banksSet);
			if (input.userId) {
				await ensureBankExists(this.#client, userBankId(input.userId), this.#config, banksSet);
			}
			const calls: Array<Promise<RecallResult[]>> = [];
			if (taskTags) {
				calls.push(
					this.#client
						.recall(repoBankId(input.repoId), query, {
							tags: taskTags,
							tagsMatch: "all_strict",
							maxTokens: this.#config.workflowTaskTokens ?? 1_800,
						})
						.then(response => response.results ?? []),
				);
			} else {
				calls.push(Promise.resolve([]));
			}
			calls.push(
				this.#client
					.recall(repoBankId(input.repoId), query, {
						tags: [`repo:${input.repoId}`, "kind:repo-fact"],
						tagsMatch: "all_strict",
						maxTokens: this.#config.workflowRepoTokens ?? 1_200,
					})
					.then(response => response.results ?? []),
			);
			if (input.userId) {
				calls.push(
					this.#client
						.recall(userBankId(input.userId), query, {
							tags: ["kind:user-preference"],
							tagsMatch: "all_strict",
							maxTokens: this.#config.workflowUserTokens ?? 600,
						})
						.then(response => response.results ?? []),
				);
			} else {
				calls.push(Promise.resolve([]));
			}
			const [taskResults = [], repoResults = [], userResults = []] = await Promise.all(calls);
			const taskMemories = memoryItems(taskResults);
			const repoMemories = memoryItems(repoResults).filter(
				item => !taskMemories.some(task => task.text === item.text),
			);
			const userMemories = memoryItems(userResults).filter(
				item =>
					!taskMemories.some(task => task.text === item.text) &&
					!repoMemories.some(repo => repo.text === item.text),
			);
			if (taskMemories.length === 0 && repoMemories.length === 0 && userMemories.length === 0) {
				return { degraded: false };
			}
			return {
				content: prompt.render(workflowMemoryContextPrompt, { taskMemories, repoMemories, userMemories }),
				degraded: false,
			};
		} catch (error) {
			logger.warn("Workflow Hindsight recall unavailable; continuing with registry and Git state", {
				error: String(error),
				repoId: input.repoId,
				taskId: input.taskId,
			});
			return { degraded: true };
		}
	}

	recallForIntake(input: { userId: string; repoId: string; taskDraft: string }): Promise<MemoryContext> {
		return this.#recall(input.taskDraft, { repoId: input.repoId, userId: input.userId });
	}

	recallForPlanning(input: {
		repoId: string;
		taskId: string;
		goal: string;
		changedFiles?: string[];
	}): Promise<MemoryContext> {
		const query = input.changedFiles?.length ? `${input.goal}\n${input.changedFiles.join("\n")}` : input.goal;
		return this.#recall(query, {
			repoId: input.repoId,
			taskId: input.taskId,
			userId: this.#config.userId ?? "default",
		});
	}

	recallForRecovery(input: {
		repoId: string;
		taskId: string;
		attemptId: string;
		failure: string;
	}): Promise<MemoryContext> {
		return this.#recall(input.failure, {
			repoId: input.repoId,
			taskId: input.taskId,
			userId: this.#config.userId ?? "default",
		});
	}

	async retain(record: DurableMemoryRecord): Promise<void> {
		const repoId = record.applicability.repoId;
		const taskId = record.applicability.taskId;
		const bankId =
			record.kind === "user-preference"
				? userBankId(this.#config.userId ?? "default")
				: repoBankId(repoId ?? "unknown");
		const documentId = record.documentId ?? `event/${crypto.randomUUID()}`;
		const rawContent = record.rationale ? `${record.statement}\n\n${record.rationale}` : record.statement;
		const content = this.#config.redactionEnabled === false ? rawContent : (this.#redact?.(rawContent) ?? rawContent);
		const tags = [
			repoId ? `repo:${repoId}` : undefined,
			taskId ? `task:${taskId}` : undefined,
			record.attemptId ? `attempt:${record.attemptId}` : undefined,
			`kind:${record.kind}`,
			"status:active",
			"source:agent",
			record.specVersion ? `spec:${record.specVersion}` : undefined,
		].filter((tag): tag is string => tag !== undefined);
		const metadata: Record<string, string> = {
			machine_id: this.#machineId,
			omp_session_id: this.#sessionId,
			confidence: record.confidence,
		};
		const episodeId = this.#episodeId();
		if (episodeId) metadata.episode_id = episodeId;
		if (repoId) metadata.repo_id = repoId;
		if (taskId) metadata.task_id = taskId;
		if (record.attemptId) metadata.attempt_id = record.attemptId;
		if (record.specVersion) metadata.spec_version = String(record.specVersion);
		if (record.planVersion) metadata.plan_version = String(record.planVersion);
		if (record.commit) metadata.commit = record.commit;
		if (record.evidence[0]) metadata.evidence_id = record.evidence[0].evidenceId;
		const request: QueuedRetainRequest = {
			content,
			context: `workflow:${record.kind}`,
			metadata,
			documentId,
			tags,
			updateMode: record.mutable ? "replace" : "append",
		};
		this.#store.enqueueMemory({
			id: crypto.randomUUID(),
			bankId,
			documentId,
			contentHash: hash(JSON.stringify(request)),
			request: { ...request },
			mutable: record.mutable === true,
		});
		void this.flushOutbox();
	}

	replaceCurrentTaskSummary(input: { repoId: string; taskId: string; summary: string }): Promise<void> {
		return this.retain({
			kind: "decision",
			statement: input.summary,
			applicability: { repoId: input.repoId, taskId: input.taskId },
			evidence: [],
			confidence: "confirmed",
			documentId: `task/${input.taskId}/current-summary`,
			mutable: true,
		});
	}

	flushOutbox(): Promise<void> {
		if (this.#flushPromise) return this.#flushPromise;
		const flush = this.#doFlush().finally(() => {
			if (this.#flushPromise === flush) this.#flushPromise = undefined;
		});
		this.#flushPromise = flush;
		return flush;
	}

	async #doFlush(): Promise<void> {
		for (const item of this.#store.pendingMemory()) {
			const request = requestFromRecord(item.request);
			if (!request) {
				this.#store.markMemoryRetry(item.id, item.attempts, 1);
				continue;
			}
			try {
				await ensureBankExists(this.#client, item.bankId, this.#config, banksSet);
				const options: RetainOptions = {
					context: request.context,
					metadata: request.metadata,
					documentId: request.documentId,
					tags: request.tags,
					updateMode: request.updateMode,
					async: true,
				};
				await this.#client.retain(item.bankId, request.content, options);
				this.#store.markMemoryDelivered(item.id);
			} catch (error) {
				this.#store.markMemoryRetry(item.id, item.attempts, this.#config.outboxRetryMax ?? 20);
				logger.debug("Workflow Hindsight retain queued for retry", {
					error: String(error),
					bankId: item.bankId,
					documentId: item.documentId,
				});
				return;
			}
		}
	}
}
