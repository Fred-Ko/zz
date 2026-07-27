import { escapeXmlAttribute, escapeXmlText, isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import developerWorkingPreferencesPrompt from "../prompts/knowledge/mental-models/developer-working-preferences.md" with {
	type: "text",
};
import repoArchitectureDecisionsPrompt from "../prompts/knowledge/mental-models/repo-architecture-decisions.md" with {
	type: "text",
};
import repoDebuggingValidationPlaybookPrompt from "../prompts/knowledge/mental-models/repo-debugging-validation-playbook.md" with {
	type: "text",
};
import repoKnownPitfallsPrompt from "../prompts/knowledge/mental-models/repo-known-pitfalls.md" with { type: "text" };
import repoOperatingManualPrompt from "../prompts/knowledge/mental-models/repo-operating-manual.md" with {
	type: "text",
};
import workingSetPrompt from "../prompts/knowledge/working-set.md" with { type: "text" };
import { createKnowledgeBankProfile, profileStatus } from "./bank-profile";
import { bankForScope, createKnowledgeBankRefs } from "./bank-routing";
import { type KnowledgeConfig, loadKnowledgeConfig } from "./config";
import {
	HindsightKnowledgeClient,
	type HindsightKnowledgeMentalModel,
	type HindsightKnowledgeRecallResponse,
	KnowledgeProviderError,
} from "./hindsight-client";
import { KnowledgeStore, knowledgeDbPath, registerKnowledgeBank } from "./store";
import {
	compileObservationScopes,
	compileRecallTagGroups,
	compileRecordTags,
	KNOWLEDGE_SCHEMA_TAG,
	type KnowledgeClassification,
	normalizeKnowledgeKey,
	scopeTags,
	sourceFromEvidence,
	tagsByNamespace,
} from "./tag-policy";
import type {
	KnowledgeBankKind,
	KnowledgeBankNameSource,
	KnowledgeBankRef,
	KnowledgeBankStatus,
	KnowledgeContentClass,
	KnowledgeCurateInput,
	KnowledgeDepth,
	KnowledgeDocumentRetainInput,
	KnowledgeDomain,
	KnowledgeForm,
	KnowledgeGroupActionInput,
	KnowledgeIdentity,
	KnowledgeMentalModelName,
	KnowledgeProviderActivity,
	KnowledgeRecallInput,
	KnowledgeRecallItem,
	KnowledgeReflectInput,
	KnowledgeRequestContext,
	KnowledgeRetainGroup,
	KnowledgeRetainInput,
	KnowledgeRetainReceipt,
	KnowledgeReviewRequest,
	KnowledgeRuntime,
	KnowledgeScope,
	KnowledgeScopeName,
	KnowledgeStatus,
	KnowledgeWorkingSet,
} from "./types";

export interface CreateKnowledgeRuntimeOptions {
	settings: Settings;
	agentDir: string;
	repoId: string;
	repositoryDisplayName?: string;
	repositoryNameSource?: KnowledgeBankNameSource;
	enabled?: boolean;
	redact?(content: string): string;
}

interface RetainRequest {
	content: string;
	context: string;
	metadata: Record<string, string>;
	documentId: string;
	tags: string[];
	occurredAt?: string;
	updateMode: "append" | "replace";
	strategy: string;
	observationScopes: string[][];
	async?: boolean;
	refreshMentalModelIds?: string[];
}

interface MentalModelDefinition {
	id: string;
	name: KnowledgeMentalModelName;
	sourceQuery: string;
	tags: string[];
	maxTokens: number;
}

const ensuredBanks = new Set<string>();
const ensuredMentalModelSets = new Set<string>();

function hash(value: unknown): string {
	return Bun.hash(typeof value === "string" ? value : JSON.stringify(value))
		.toString(16)
		.padStart(16, "0");
}

function canonicalObject(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalObject);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, canonicalObject(item)]),
	);
}

function configHash(value: unknown): string {
	return hash(JSON.stringify(canonicalObject(value)));
}

const REPOSITORY_MENTAL_MODELS: ReadonlyArray<{
	name: Exclude<KnowledgeMentalModelName, "developer-working-preferences">;
	sourceQuery: string;
}> = [
	{ name: "repo-operating-manual", sourceQuery: repoOperatingManualPrompt },
	{ name: "repo-architecture-decisions", sourceQuery: repoArchitectureDecisionsPrompt },
	{ name: "repo-known-pitfalls", sourceQuery: repoKnownPitfallsPrompt },
	{ name: "repo-debugging-validation-playbook", sourceQuery: repoDebuggingValidationPlaybookPrompt },
];

function mentalModelDefinitions(
	config: KnowledgeConfig,
	repoId: string,
	bankKind?: KnowledgeBankKind,
): MentalModelDefinition[] {
	const repoSuffix = hash(repoId);
	const global: MentalModelDefinition = {
		id: "developer-working-preferences",
		name: "developer-working-preferences",
		sourceQuery: developerWorkingPreferencesPrompt.trim(),
		tags: [KNOWLEDGE_SCHEMA_TAG, "scope:global", "status:active"],
		maxTokens: 1_000,
	};
	const repository = REPOSITORY_MENTAL_MODELS.slice(0, config.mentalModelMaxPerRepo).map(value => ({
		id: `${value.name}-${repoSuffix}`,
		name: value.name,
		sourceQuery: value.sourceQuery.trim(),
		tags: [KNOWLEDGE_SCHEMA_TAG, ...scopeTags("repo", { repoId, sessionId: "mental-model" }), "status:active"],
		maxTokens: 1_500,
	}));
	if (bankKind === "global") return [global];
	if (bankKind === "repository") return repository;
	return [global, ...repository];
}

interface KnowledgeBankTarget {
	bank: KnowledgeBankRef;
	tags: string[];
}

function bankTargets(
	banks: { global: KnowledgeBankRef; repository: KnowledgeBankRef },
	scope: KnowledgeScope,
	identity: KnowledgeIdentity,
): KnowledgeBankTarget[] {
	const targets: KnowledgeBankTarget[] = [];
	if (scope.global) {
		targets.push({ bank: banks.global, tags: [KNOWLEDGE_SCHEMA_TAG, ...scopeTags("global", identity)] });
	}
	if (scope.repo) {
		targets.push({ bank: banks.repository, tags: [KNOWLEDGE_SCHEMA_TAG, ...scopeTags("repo", identity)] });
	}
	if (scope.task && identity.taskId) {
		targets.push({ bank: banks.repository, tags: [KNOWLEDGE_SCHEMA_TAG, ...scopeTags("task", identity)] });
	}
	return targets.length > 0
		? targets
		: [{ bank: banks.repository, tags: [KNOWLEDGE_SCHEMA_TAG, ...scopeTags("repo", identity)] }];
}

function baseMetadata(
	identity: KnowledgeIdentity,
	input: {
		futureUse: string;
		sourceRefs: Array<{ id: string }>;
		request: KnowledgeRequestContext;
		knowledgeKey: string;
		contentClass: KnowledgeContentClass;
	},
): Record<string, string> {
	const value: Record<string, string> = {
		repo_id: identity.repoId,
		session_id: identity.sessionId,
		future_use: input.futureUse,
		evidence_ids: input.sourceRefs.map(ref => ref.id).join(","),
		retain_group_id: input.request.groupId,
		request_origin: input.request.origin,
		knowledge_key: input.knowledgeKey,
		content_class: input.contentClass,
	};
	if (input.request.sourceRequestId) value.source_request_id = input.request.sourceRequestId;
	if (input.request.userMessageEntryId) value.user_message_entry_id = input.request.userMessageEntryId;
	if (identity.taskId) value.task_id = identity.taskId;
	if (identity.branchId) value.branch_name_at_discovery = identity.branchId;
	if (identity.branchId && identity.commitHash) value.branch_head_at_discovery = identity.commitHash;
	if (identity.attemptId) value.attempt_id = identity.attemptId;
	if (identity.episodeId) value.episode_id = identity.episodeId;
	if (identity.commitHash) value.commit_hash = identity.commitHash;
	if (identity.specVersion !== undefined) value.spec_version = String(identity.specVersion);
	if (identity.planVersion !== undefined) value.plan_version = String(identity.planVersion);
	return value;
}

function defaultRequest(identity: KnowledgeIdentity, knowledgeKey: string): KnowledgeRequestContext {
	const source = identity.episodeId ?? identity.taskId ?? knowledgeKey;
	return {
		groupId: `retain-${hash(`${identity.sessionId}:${source}`)}`,
		origin: "agent-initiated",
	};
}

function requestFromValue(value: Record<string, unknown>): RetainRequest | undefined {
	if (
		typeof value.content !== "string" ||
		typeof value.context !== "string" ||
		typeof value.documentId !== "string" ||
		typeof value.strategy !== "string" ||
		!isRecord(value.metadata) ||
		!Array.isArray(value.tags) ||
		!Array.isArray(value.observationScopes) ||
		(value.updateMode !== "append" && value.updateMode !== "replace")
	) {
		return undefined;
	}
	const stringMetadata = Object.fromEntries(
		Object.entries(value.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	const tags = value.tags.filter((tag): tag is string => typeof tag === "string");
	const observationScopes = value.observationScopes
		.filter((item): item is unknown[] => Array.isArray(item))
		.map(item => item.filter((tag): tag is string => typeof tag === "string"));
	return {
		content: value.content,
		context: value.context,
		metadata: stringMetadata,
		documentId: value.documentId,
		tags,
		occurredAt: typeof value.occurredAt === "string" ? value.occurredAt : undefined,
		updateMode: value.updateMode,
		strategy: value.strategy,
		observationScopes,
		async: typeof value.async === "boolean" ? value.async : undefined,
		refreshMentalModelIds: Array.isArray(value.refreshMentalModelIds)
			? value.refreshMentalModelIds.filter((id): id is string => typeof id === "string")
			: undefined,
	};
}

function normalizeRecallItems(response: HindsightKnowledgeRecallResponse): KnowledgeRecallItem[] {
	const sourceFactsById = response.source_facts ?? {};
	const seen = new Set<string>();
	const items: KnowledgeRecallItem[] = [];
	for (const result of response.results ?? []) {
		const text = result.text.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		const responseSourceFactIds =
			result.type === "observation"
				? Object.keys(sourceFactsById).filter(id => sourceFactsById[id] !== undefined)
				: [];
		const sourceFactIds =
			result.source_fact_ids ?? (responseSourceFactIds.length > 0 ? responseSourceFactIds : undefined);
		items.push({
			id: result.id ?? `knowledge-${hash(text)}`,
			text,
			type: result.type ?? undefined,
			context: result.context ?? undefined,
			metadata: result.metadata ?? undefined,
			tags: result.tags ?? undefined,
			entities: result.entities ?? undefined,
			mentionedAt: result.mentioned_at ?? undefined,
			occurredStart: result.occurred_start ?? undefined,
			occurredEnd: result.occurred_end ?? undefined,
			sourceFactIds,
		});
	}
	return items;
}

function normalizeMentalModelItems(
	definitions: MentalModelDefinition[],
	models: HindsightKnowledgeMentalModel[],
	maxTokens: number,
): KnowledgeRecallItem[] {
	const byId = new Map(models.map(model => [model.id, model]));
	let remainingCharacters = maxTokens * 4;
	const items: KnowledgeRecallItem[] = [];
	for (const definition of definitions) {
		const model = byId.get(definition.id);
		const content = model?.content?.trim();
		if (!content || remainingCharacters <= 0) continue;
		const text =
			content.length <= remainingCharacters
				? content
				: `${content.slice(0, Math.max(0, remainingCharacters - 1)).trimEnd()}…`;
		remainingCharacters -= text.length;
		items.push({
			id: definition.id,
			text,
			type: "mental-model",
			mentionedAt: model?.last_refreshed_at ?? undefined,
		});
	}
	return items;
}

function mergeRecallItems(primary: KnowledgeRecallItem[], secondary: KnowledgeRecallItem[]): KnowledgeRecallItem[] {
	const seen = new Set<string>();
	const merged: KnowledgeRecallItem[] = [];
	for (const item of [...primary, ...secondary]) {
		const key = item.text.trim().toLocaleLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
	}
	return merged;
}

function workingSetContent(value: Omit<KnowledgeWorkingSet, "content">): string | undefined {
	if (value.items.length === 0) return undefined;
	return prompt.render(workingSetPrompt, {
		id: escapeXmlAttribute(value.id),
		purpose: escapeXmlAttribute(value.purpose),
		items: value.items.map(item => ({
			id: escapeXmlAttribute(item.id),
			text: escapeXmlText(item.text),
		})),
	});
}

function depthTokens(config: KnowledgeConfig, depth: KnowledgeDepth): number {
	return config.tokens[depth];
}

function firstTagValue(values: Map<string, string[]>, namespace: string): string | undefined {
	return values.get(namespace)?.[0];
}

function scopeFromTags(values: Map<string, string[]>): KnowledgeScopeName {
	const scope = firstTagValue(values, "scope");
	if (scope === "global" || scope === "repo" || scope === "task") return scope;
	return "repo";
}

function formFromTags(values: Map<string, string[]>): KnowledgeForm {
	const form = firstTagValue(values, "form");
	if (
		form === "preference" ||
		form === "fact" ||
		form === "decision" ||
		form === "constraint" ||
		form === "procedure" ||
		form === "failure" ||
		form === "pitfall" ||
		form === "lesson"
	) {
		return form;
	}
	return "fact";
}

function domainFromTags(values: Map<string, string[]>): KnowledgeDomain {
	const domain = firstTagValue(values, "domain");
	if (
		domain === "user" ||
		domain === "repository" ||
		domain === "architecture" ||
		domain === "product" ||
		domain === "implementation" ||
		domain === "debugging" ||
		domain === "verification" ||
		domain === "workflow" ||
		domain === "operations"
	) {
		return domain;
	}
	return "repository";
}

export class ZzKnowledgeRuntime implements KnowledgeRuntime {
	readonly #config: KnowledgeConfig;
	readonly #client: HindsightKnowledgeClient;
	readonly #store: KnowledgeStore;
	readonly #repoId: string;
	readonly #agentDir: string;
	readonly #redact?: (content: string) => string;
	readonly #banks: { global: KnowledgeBankRef; repository: KnowledgeBankRef };
	#workingSet: KnowledgeWorkingSet | undefined;
	#providerActivity: KnowledgeProviderActivity | undefined;
	#flushPromise: Promise<void> | undefined;
	#closed = false;

	constructor(options: CreateKnowledgeRuntimeOptions) {
		const config = loadKnowledgeConfig(options.settings);
		this.#config = options.enabled === undefined ? config : { ...config, enabled: options.enabled };
		this.#repoId = options.repoId;
		this.#agentDir = options.agentDir;
		this.#redact = options.redact;
		this.#banks = createKnowledgeBankRefs({
			config: this.#config,
			repositoryId: options.repoId,
			repositoryDisplayName: options.repositoryDisplayName ?? options.repoId,
			repositoryNameSource: options.repositoryNameSource ?? "generated",
		});
		this.#store = new KnowledgeStore(
			knowledgeDbPath(options.agentDir, `${this.#config.userId}:${this.#config.securityBoundary}`),
		);
		this.#client = new HindsightKnowledgeClient({
			baseUrl: this.#config.apiUrl,
			apiKey: this.#config.apiToken,
			requestTimeoutMs: this.#config.requestTimeoutMs,
			reflectTimeoutMs: this.#config.reflectTimeoutMs,
			recallTimeoutMs: this.#config.recallTimeoutMs,
			retainTimeoutMs: this.#config.retainTimeoutMs,
		});
		if (this.#config.enabled) void this.flushOutbox();
	}

	#bankKey(bank: KnowledgeBankRef): string {
		return `${this.#config.apiUrl}|${bank.bankId}|${hash(bank.displayName)}`;
	}

	async #ensureBank(bank: KnowledgeBankRef): Promise<void> {
		const bankKey = this.#bankKey(bank);
		if (ensuredBanks.has(bankKey)) return;
		registerKnowledgeBank(
			this.#agentDir,
			this.#config.userId,
			this.#config.securityBoundary,
			bank,
			this.#config.maxBanksPerUser,
		);
		await this.#client.createBank(bank.bankId, bank.displayName);
		const profile = createKnowledgeBankProfile();
		const current = await this.#client.getBankConfig(bank.bankId);
		const overrides = current.overrides ?? {};
		const selected = Object.fromEntries(Object.keys(profile.config).map(key => [key, overrides[key]]));
		const currentHash = configHash(selected);
		if (this.#config.managedConfigMode === "merge" && currentHash !== profile.hash) {
			await this.#client.updateBankConfig(bank.bankId, profile.config);
			this.#store.putBankProfile(bank.bankId, profileStatus(this.#config.managedConfigMode, profile.hash));
		} else {
			this.#store.putBankProfile(
				bank.bankId,
				profileStatus(this.#config.managedConfigMode, currentHash === profile.hash ? profile.hash : currentHash),
			);
		}
		ensuredBanks.add(bankKey);
		if (ensuredBanks.size > 1_000) ensuredBanks.delete(ensuredBanks.values().next().value ?? "");
	}

	async #ensureMentalModels(bank: KnowledgeBankRef, repoId: string): Promise<MentalModelDefinition[]> {
		const definitions = mentalModelDefinitions(this.#config, repoId, bank.kind);
		if (!this.#config.mentalModelsEnabled) return [];
		await this.#ensureBank(bank);
		const key = `${this.#bankKey(bank)}|${repoId}|${bank.kind}`;
		if (ensuredMentalModelSets.has(key)) return definitions;
		const existing = await this.#client.listMentalModels(bank.bankId, "metadata");
		const existingIds = new Set((existing.items ?? []).map(model => model.id));
		for (const definition of definitions) {
			if (existingIds.has(definition.id)) continue;
			await this.#client.createMentalModel(bank.bankId, definition);
		}
		ensuredMentalModelSets.add(key);
		if (ensuredMentalModelSets.size > 1_000) {
			ensuredMentalModelSets.delete(ensuredMentalModelSets.values().next().value ?? "");
		}
		return definitions;
	}

	async #loadMentalModelItems(repoId: string): Promise<KnowledgeRecallItem[]> {
		if (!this.#config.mentalModelsEnabled) return [];
		try {
			const responses = await Promise.all(
				[this.#banks.global, this.#banks.repository].map(async bank => {
					const definitions = await this.#ensureMentalModels(bank, repoId);
					const response = await this.#client.listMentalModels(bank.bankId, "content");
					return normalizeMentalModelItems(
						definitions,
						response.items ?? [],
						Math.floor(this.#config.mentalModelOrientationTokens / 2),
					);
				}),
			);
			return mergeRecallItems(responses[0] ?? [], responses[1] ?? []);
		} catch (error) {
			logger.debug("ZZ knowledge mental-model orientation unavailable", {
				error: String(error),
				repoId,
			});
			return [];
		}
	}

	async status(): Promise<KnowledgeStatus> {
		return {
			enabled: this.#config.enabled,
			provider: "hindsight",
			securityBoundary: this.#config.securityBoundary,
			globalBank: this.#config.enabled
				? { ...this.#banks.global, profile: this.#store.getBankProfile(this.#banks.global.bankId) }
				: undefined,
			repositoryBank: this.#config.enabled
				? { ...this.#banks.repository, profile: this.#store.getBankProfile(this.#banks.repository.bankId) }
				: undefined,
			queued: this.#store.queuedCount(),
			pendingReviews: this.#store.pendingReviewCount(),
			groupCount: this.#store.groupCount(this.#repoId),
			workingSet: this.#workingSet,
			providerActivity: this.#providerActivity ? { ...this.#providerActivity } : undefined,
		};
	}

	#recordProviderActivity(operation: KnowledgeProviderActivity["operation"], error?: unknown): void {
		this.#providerActivity = error
			? {
					operation,
					status: "failed",
					at: new Date().toISOString(),
					statusCode: error instanceof KnowledgeProviderError ? error.statusCode : undefined,
					error: error instanceof Error ? error.message : String(error),
				}
			: { operation, status: "ok", at: new Date().toISOString() };
	}

	async listBanks(): Promise<KnowledgeBankStatus[]> {
		const status = await this.status();
		return [status.globalBank, status.repositoryBank].filter(
			(bank): bank is KnowledgeBankStatus => bank !== undefined,
		);
	}

	async recall(input: KnowledgeRecallInput): Promise<KnowledgeWorkingSet> {
		const queryHash = hash(input.query);
		const scopeHash = hash({
			scope: input.scope,
			repoId: input.identity.repoId,
			taskId: input.identity.taskId,
			specVersion: input.identity.specVersion,
			planVersion: input.identity.planVersion,
			commitHash: input.identity.commitHash,
		});
		const cacheKey = hash({
			purpose: input.purpose,
			queryHash,
			scopeHash,
			depth: input.depth,
			forms: input.forms,
			domains: input.domains,
			components: input.components,
			includeSourceFacts: input.includeSourceFacts === true,
			includeChunks: input.includeChunks === true,
		});
		const cached = this.#store.getWorkingSet(cacheKey);
		if (cached) {
			this.#workingSet = { ...cached, cached: true };
			return this.#workingSet;
		}
		const base: Omit<KnowledgeWorkingSet, "content"> = {
			id: `working-set-${cacheKey}`,
			purpose: input.purpose,
			queryHash,
			scopeHash,
			items: [],
			degraded: false,
			cached: false,
			createdAt: new Date().toISOString(),
		};
		if (!this.#config.enabled || this.#closed) {
			const disabled = { ...base, degraded: false };
			this.#workingSet = disabled;
			return disabled;
		}
		try {
			const targets = bankTargets(this.#banks, input.scope, input.identity);
			await Promise.all([...new Set(targets.map(target => target.bank))].map(bank => this.#ensureBank(bank)));
			const totalTokens = depthTokens(this.#config, input.depth);
			const recallTokens =
				input.purpose === "session-orientation" && this.#config.mentalModelsEnabled
					? Math.max(512, totalTokens - this.#config.mentalModelOrientationTokens)
					: totalTokens;
			const tokensPerScope = Math.max(256, Math.floor(recallTokens / targets.length));
			const mentalModelPromise =
				input.purpose === "session-orientation"
					? this.#loadMentalModelItems(input.identity.repoId)
					: Promise.resolve([]);
			const tagGroups = compileRecallTagGroups(input);
			const responses = await Promise.all(
				targets.map(target =>
					this.#client.recall(target.bank.bankId, input.query, {
						maxTokens: tokensPerScope,
						tags: target.tags,
						tagsMatch: "all_strict",
						tagGroups,
						types: ["world", "experience", "observation"],
						preferObservations: true,
						includeSourceFacts: input.includeSourceFacts,
						includeChunks: input.includeChunks,
					}),
				),
			);
			const mentalModelItems = await mentalModelPromise;
			const resolved: Omit<KnowledgeWorkingSet, "content"> = {
				...base,
				items: mergeRecallItems(mentalModelItems, responses.flatMap(normalizeRecallItems)),
			};
			const workingSet: KnowledgeWorkingSet = {
				...resolved,
				content: workingSetContent(resolved),
			};
			this.#store.putWorkingSet(
				cacheKey,
				input.identity.repoId,
				workingSet,
				Date.now() + this.#config.workingSetTtlMs,
			);
			this.#workingSet = workingSet;
			this.#recordProviderActivity("recall");
			return workingSet;
		} catch (error) {
			this.#recordProviderActivity("recall", error);
			logger.warn("ZZ knowledge recall unavailable; continuing with authoritative current state", {
				error: String(error),
				purpose: input.purpose,
				repoId: input.identity.repoId,
			});
			const degraded = { ...base, degraded: true };
			this.#workingSet = degraded;
			return degraded;
		}
	}

	async retain(input: KnowledgeRetainInput): Promise<KnowledgeRetainReceipt> {
		if (!this.#config.enabled || this.#closed) return { status: "rejected", reason: "knowledge-disabled" };
		if (!input.statement.trim()) return { status: "rejected", reason: "empty-statement" };
		if (!input.futureUse.trim()) return { status: "rejected", reason: "future-use-required" };
		if (input.sourceRefs.length === 0) return { status: "rejected", reason: "evidence-required" };
		if (this.#config.rejectAgentInferredRepoKnowledge && input.source === "agent" && input.scope !== "task") {
			return { status: "rejected", reason: "agent-inferred-long-term-knowledge-is-not-allowed" };
		}
		const knowledgeKey = normalizeKnowledgeKey(input.knowledgeKey);
		if (this.#config.deduplicateBeforeRetain) {
			const duplicate = await this.recall({
				purpose: "implementation",
				query: input.statement,
				scope: {
					global: input.scope === "global",
					repo: input.scope === "repo",
					task: input.scope === "task",
				},
				depth: "quick",
				forms: [input.form],
				domains: [input.domain],
				components: input.applicability?.components,
				identity: input.identity,
				request: input.request,
			});
			const normalized = input.statement.trim().toLocaleLowerCase();
			if (duplicate.items.some(item => item.text.trim().toLocaleLowerCase() === normalized)) {
				return {
					status: "duplicate",
					groupId: input.request?.groupId,
					knowledgeKey,
					reason: "equivalent-knowledge-already-exists",
				};
			}
		}
		const requestContext = input.request ?? defaultRequest(input.identity, knowledgeKey);
		const classification: KnowledgeClassification = {
			scope: input.scope,
			form: input.form,
			domain: input.domain,
			source: input.source,
			confidence: input.confidence,
			applicability: input.applicability,
			request: requestContext,
		};
		const documentId =
			input.documentId ??
			`${input.scope}/${hash(input.identity.repoId)}/record/${hash(knowledgeKey)}/${hash(`${input.statement}:${input.occurredAt ?? ""}`)}`;
		const contentClass = input.contentClass ?? "durable-fact";
		const bank = bankForScope(this.#banks, input.scope);
		const raw = input.statement.trim();
		const content = this.#config.redactionEnabled ? (this.#redact?.(raw) ?? raw) : raw;
		const request: RetainRequest = {
			content,
			context: `zz-knowledge:${input.domain}:${input.form}`,
			metadata: {
				...baseMetadata(input.identity, {
					futureUse: input.futureUse,
					sourceRefs: input.sourceRefs,
					request: requestContext,
					knowledgeKey,
					contentClass,
				}),
				form: input.form,
				domain: input.domain,
				source: input.source,
				confidence: input.confidence,
				...(input.supersedes ? { supersedes: input.supersedes } : {}),
				...(input.applicability?.validFrom ? { valid_from: input.applicability.validFrom } : {}),
				...(input.applicability?.validUntil ? { valid_until: input.applicability.validUntil } : {}),
			},
			documentId,
			tags: compileRecordTags(classification, input.identity),
			occurredAt: input.occurredAt,
			updateMode: input.documentId ? "replace" : "append",
			strategy: contentClass,
			observationScopes: compileObservationScopes(classification, input.identity),
			async: !input.refreshMentalModels?.length,
			refreshMentalModelIds: input.refreshMentalModels
				? mentalModelDefinitions(this.#config, input.identity.repoId, bank.kind)
						.filter(definition => input.refreshMentalModels?.includes(definition.name))
						.map(definition => definition.id)
				: undefined,
		};
		return this.#queueRetain(bank, request, requestContext, knowledgeKey, classification, input.identity);
	}

	async retainDocument(input: KnowledgeDocumentRetainInput): Promise<KnowledgeRetainReceipt> {
		if (!this.#config.enabled || this.#closed) return { status: "rejected", reason: "knowledge-disabled" };
		if (!input.content.trim()) return { status: "rejected", reason: "empty-document" };
		if (!input.title.trim()) return { status: "rejected", reason: "document-title-required" };
		if (!input.futureUse.trim()) return { status: "rejected", reason: "future-use-required" };
		if (input.sourceRefs.length === 0) return { status: "rejected", reason: "evidence-required" };
		const knowledgeKey = normalizeKnowledgeKey(`document/${input.sourceId}`);
		const requestContext = input.request ?? defaultRequest(input.identity, knowledgeKey);
		const classification: KnowledgeClassification = {
			scope: input.scope,
			form: "fact",
			domain: input.domain,
			source: input.source,
			confidence: input.confidence,
			applicability: input.applicability,
			request: requestContext,
		};
		const baseDocumentId = `${input.scope}/${hash(input.identity.repoId)}/document/${hash(input.sourceId)}`;
		const documentId =
			input.updateMode === "immutable-revision"
				? `${baseDocumentId}/revision/${hash(`${input.version ?? ""}:${input.content}`)}`
				: baseDocumentId;
		const raw = `# ${input.title.trim()}\n\n${input.content.trim()}`;
		const bank = bankForScope(this.#banks, input.scope);
		const content = this.#config.redactionEnabled ? (this.#redact?.(raw) ?? raw) : raw;
		const request: RetainRequest = {
			content,
			context: `zz-document:${input.domain}:${input.sourceId}`,
			metadata: {
				...baseMetadata(input.identity, {
					futureUse: input.futureUse,
					sourceRefs: input.sourceRefs,
					request: requestContext,
					knowledgeKey,
					contentClass: input.contentClass,
				}),
				title: input.title.trim(),
				source_id: input.sourceId,
				domain: input.domain,
				source: input.source,
				confidence: input.confidence,
				...(input.version ? { document_version: input.version } : {}),
			},
			documentId,
			tags: compileRecordTags(classification, input.identity),
			occurredAt: input.occurredAt,
			updateMode: input.updateMode === "append" ? "append" : "replace",
			strategy: input.contentClass,
			observationScopes: compileObservationScopes(classification, input.identity),
			async: !input.refreshMentalModels?.length,
			refreshMentalModelIds: input.refreshMentalModels
				? mentalModelDefinitions(this.#config, input.identity.repoId, bank.kind)
						.filter(definition => input.refreshMentalModels?.includes(definition.name))
						.map(definition => definition.id)
				: undefined,
		};
		return this.#queueRetain(bank, request, requestContext, knowledgeKey, classification, input.identity);
	}

	#queueRetain(
		bank: KnowledgeBankRef,
		request: RetainRequest,
		requestContext: KnowledgeRequestContext,
		knowledgeKey: string,
		classification: KnowledgeClassification,
		identity: KnowledgeIdentity,
	): KnowledgeRetainReceipt {
		const outboxId = crypto.randomUUID();
		const memberId = crypto.randomUUID();
		const inserted = this.#store.enqueue({
			id: outboxId,
			bankId: bank.bankId,
			documentId: request.documentId,
			contentHash: hash(request),
			request: { ...request },
			groupId: requestContext.groupId,
			memberId,
			requestContext,
			repoId: identity.repoId,
			taskId: identity.taskId,
			knowledgeKey,
			classification: { ...classification },
		});
		if (!inserted) {
			return {
				status: "duplicate",
				groupId: requestContext.groupId,
				documentId: request.documentId,
				knowledgeKey,
				reason: "same-payload-already-queued",
			};
		}
		void this.flushOutbox();
		return {
			status: "queued",
			groupId: requestContext.groupId,
			memberId,
			documentId: request.documentId,
			knowledgeKey,
			outboxId,
		};
	}

	async reflect(input: KnowledgeReflectInput): Promise<string> {
		if (!this.#config.enabled || this.#closed) throw new Error("ZZ Knowledge System is disabled");
		const targets = bankTargets(this.#banks, input.scope, input.identity);
		await Promise.all([...new Set(targets.map(target => target.bank))].map(bank => this.#ensureBank(bank)));
		let responses: Array<{ text?: string }>;
		try {
			responses = await Promise.all(
				targets.map(target =>
					this.#client.reflect(target.bank.bankId, input.question, {
						context: `purpose:${input.purpose}`,
						tags: target.tags,
						tagsMatch: "all_strict",
						tagGroups: [{ tags: ["status:active"], match: "all_strict" }],
					}),
				),
			);
			this.#recordProviderActivity("reflect");
		} catch (error) {
			this.#recordProviderActivity("reflect", error);
			throw error;
		}
		const texts = responses.map(response => response.text?.trim()).filter((text): text is string => Boolean(text));
		return texts.length > 0 ? texts.join("\n\n") : "종합할 수 있는 관련 지식이 없습니다.";
	}

	async curate(input: KnowledgeCurateInput): Promise<void> {
		if (!this.#config.enabled || this.#closed) throw new Error("ZZ Knowledge System is disabled");
		const bank = bankForScope(this.#banks, input.documentId.startsWith("global/") ? "global" : "repo");
		await this.#ensureBank(bank);
		const document = await this.#client.getDocument(bank.bankId, input.documentId);
		if (!document) throw new Error(`knowledge document not found: ${input.documentId}`);
		const currentTags = Array.isArray(document.tags)
			? document.tags.filter((tag): tag is string => typeof tag === "string")
			: [];
		const withoutStatus = currentTags.filter(tag => !tag.startsWith("status:"));
		if (input.action === "invalidate") {
			await this.#client.updateDocument(bank.bankId, input.documentId, [...withoutStatus, "status:invalidated"]);
			return;
		}
		if (input.action === "restore") {
			await this.#client.updateDocument(bank.bankId, input.documentId, [...withoutStatus, "status:active"]);
			return;
		}
		if (!input.correctedText?.trim() || !input.evidenceRefs?.length) {
			throw new Error("correct requires correctedText and evidenceRefs");
		}
		const namespaces = tagsByNamespace(currentTags);
		const documentMetadata = isRecord(document.metadata) ? document.metadata : {};
		const priorKnowledgeKey =
			typeof documentMetadata.knowledge_key === "string"
				? documentMetadata.knowledge_key
				: `corrected/${hash(input.documentId)}`;
		await this.#client.updateDocument(bank.bankId, input.documentId, [...withoutStatus, "status:superseded"]);
		const receipt = await this.retain({
			scope: scopeFromTags(namespaces),
			form: formFromTags(namespaces),
			domain: domainFromTags(namespaces),
			source: sourceFromEvidence(input.evidenceRefs),
			confidence: "confirmed",
			knowledgeKey: priorKnowledgeKey,
			statement: input.correctedText,
			futureUse: input.reason,
			sourceRefs: input.evidenceRefs,
			identity: input.identity,
			request: input.request,
			documentId: `${input.documentId}/replacement/${hash(input.correctedText)}`,
			supersedes: input.documentId,
		});
		if (receipt.status === "rejected") {
			throw new Error(`corrected knowledge was rejected: ${receipt.reason}`);
		}
	}

	async curateGroup(input: KnowledgeGroupActionInput): Promise<void> {
		if (!this.#config.enabled || this.#closed) throw new Error("ZZ Knowledge System is disabled");
		await this.flushOutbox();
		const members = this.#store.groupMembers(input.groupId);
		if (members.length === 0) throw new Error(`knowledge retain group not found: ${input.groupId}`);
		if (members.some(member => member.status === "queued" || member.status === "failed")) {
			throw new Error(
				`knowledge retain group ${input.groupId} is not fully delivered; flush or repair its outbox before curation`,
			);
		}
		for (const member of members) {
			const bank = [this.#banks.global, this.#banks.repository].find(value => value.bankId === member.bankId);
			if (bank) await this.#ensureBank(bank);
			if (input.action === "purge") {
				await this.#client.deleteDocument(member.bankId, member.documentId);
				continue;
			}
			const document = await this.#client.getDocument(member.bankId, member.documentId);
			if (!document) continue;
			const tags = Array.isArray(document.tags)
				? document.tags.filter((tag): tag is string => typeof tag === "string")
				: [];
			const withoutStatus = tags.filter(tag => !tag.startsWith("status:"));
			await this.#client.updateDocument(member.bankId, member.documentId, [
				...withoutStatus,
				input.action === "invalidate" ? "status:invalidated" : "status:active",
			]);
		}
		this.#store.setGroupActionStatus(
			input.groupId,
			input.action === "invalidate" ? "invalidated" : input.action === "restore" ? "completed" : "purged",
		);
	}

	async listGroups(limit = 50): Promise<KnowledgeRetainGroup[]> {
		return this.#store.listGroups(this.#repoId, limit);
	}

	async requestReview(input: KnowledgeReviewRequest): Promise<void> {
		this.#store.addReview(input);
	}

	async listReviews(): Promise<KnowledgeReviewRequest[]> {
		return this.#store.listReviews(this.#repoId);
	}

	flushOutbox(): Promise<void> {
		if (!this.#config.enabled || this.#closed) return Promise.resolve();
		if (this.#store.queuedCount() === 0) return Promise.resolve();
		if (this.#flushPromise) return this.#flushPromise;
		this.#flushPromise = this.#flush().finally(() => {
			this.#flushPromise = undefined;
		});
		return this.#flushPromise;
	}

	async #flush(): Promise<void> {
		while (true) {
			const pending = this.#store.pending();
			if (pending.length === 0) break;
			for (const item of pending) {
				const bank = [this.#banks.global, this.#banks.repository].find(value => value.bankId === item.bankId);
				if (bank) {
					try {
						await this.#ensureBank(bank);
					} catch (error) {
						logger.warn("ZZ knowledge outbox delivery unavailable; queued record was preserved", {
							error: String(error),
							bankId: item.bankId,
						});
						return;
					}
				}
				const request = requestFromValue(item.request);
				if (!request) {
					this.#store.markRetry(item.id, item.attempts, 1, item.groupId, item.memberId, "invalid-retain-request");
					continue;
				}
				try {
					await this.#client.retain(item.bankId, request);
					this.#recordProviderActivity("retain");
					this.#store.markDelivered(item.id, item.groupId, item.memberId);
					if (request.refreshMentalModelIds?.length) {
						try {
							const repoId = request.metadata.repo_id;
							if (repoId && bank) await this.#ensureMentalModels(bank, repoId);
							for (const mentalModelId of request.refreshMentalModelIds) {
								await this.#client.refreshMentalModel(item.bankId, mentalModelId);
							}
						} catch (error) {
							logger.warn("ZZ knowledge mental-model refresh failed after retain delivery", {
								error: String(error),
								documentId: item.documentId,
							});
						}
					}
				} catch (error) {
					this.#recordProviderActivity("retain", error);
					this.#store.markRetry(
						item.id,
						item.attempts,
						this.#config.outboxRetryMax,
						item.groupId,
						item.memberId,
						String(error),
					);
					logger.warn("ZZ knowledge retain delivery failed", {
						documentId: item.documentId,
						error: String(error),
					});
				}
			}
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		await this.flushOutbox();
		this.#closed = true;
		this.#store.close();
	}
}

export function createKnowledgeRuntime(options: CreateKnowledgeRuntimeOptions): KnowledgeRuntime {
	return new ZzKnowledgeRuntime(options);
}
