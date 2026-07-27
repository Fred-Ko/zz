import type { Settings } from "../config/settings";
import type { KnowledgeDepth } from "./types";

export interface KnowledgeConfig {
	enabled: boolean;
	provider: "hindsight";
	apiUrl: string;
	apiToken?: string;
	userId: string;
	securityBoundary: string;
	repositoryDisplayName?: string;
	managedConfigMode: "merge" | "inspect-only";
	maxBanksPerUser: number;
	redactionEnabled: boolean;
	deduplicateBeforeRetain: boolean;
	rejectAgentInferredRepoKnowledge: boolean;
	showReceipts: boolean;
	workingSetTtlMs: number;
	mentalModelsEnabled: boolean;
	mentalModelMaxPerRepo: number;
	mentalModelOrientationTokens: number;
	outboxRetryMax: number;
	requestTimeoutMs: number;
	reflectTimeoutMs: number;
	recallTimeoutMs: number;
	retainTimeoutMs: number;
	tokens: Record<KnowledgeDepth, number>;
}

function positive(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function loadKnowledgeConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): KnowledgeConfig {
	return {
		enabled: settings.get("knowledge.enabled"),
		provider: "hindsight",
		apiUrl: env.ZZ_KNOWLEDGE_API_URL?.trim() || settings.get("knowledge.hindsight.apiUrl") || "http://127.0.0.1:8888",
		apiToken: env.ZZ_KNOWLEDGE_API_TOKEN?.trim() || settings.get("knowledge.hindsight.apiToken"),
		userId: settings.get("knowledge.userId")?.trim() || "default",
		securityBoundary: settings.get("knowledge.securityBoundary")?.trim() || "personal",
		repositoryDisplayName: settings.get("knowledge.repositoryDisplayName")?.trim() || undefined,
		managedConfigMode: settings.get("knowledge.bank.managedConfigMode"),
		maxBanksPerUser: positive(settings.get("knowledge.bank.maxBanksPerUser"), 4),
		redactionEnabled: settings.get("knowledge.retain.redactionEnabled"),
		deduplicateBeforeRetain: settings.get("knowledge.retain.deduplicateBeforeRetain"),
		rejectAgentInferredRepoKnowledge: settings.get("knowledge.retain.rejectAgentInferredRepoKnowledge"),
		showReceipts: settings.get("knowledge.retain.showReceipts"),
		workingSetTtlMs: positive(settings.get("knowledge.recall.workingSetTtlSeconds"), 900) * 1_000,
		mentalModelsEnabled: settings.get("knowledge.mentalModels.enabled"),
		mentalModelMaxPerRepo: Math.min(4, positive(settings.get("knowledge.mentalModels.maxPerRepo"), 4)),
		mentalModelOrientationTokens: positive(settings.get("knowledge.mentalModels.orientationTokens"), 2_500),
		outboxRetryMax: positive(settings.get("knowledge.retain.outboxRetryMax"), 20),
		requestTimeoutMs: positive(settings.get("knowledge.hindsight.requestTimeoutMs"), 30_000),
		reflectTimeoutMs: positive(settings.get("knowledge.hindsight.reflectTimeoutMs"), 120_000),
		recallTimeoutMs: positive(settings.get("knowledge.hindsight.recallTimeoutMs"), 30_000),
		retainTimeoutMs: positive(settings.get("knowledge.hindsight.retainTimeoutMs"), 60_000),
		tokens: {
			quick: positive(settings.get("knowledge.recall.quickTokens"), 1_000),
			normal: positive(settings.get("knowledge.recall.normalTokens"), 4_000),
			deep: positive(settings.get("knowledge.recall.deepTokens"), 10_000),
			forensic: positive(settings.get("knowledge.recall.forensicTokens"), 20_000),
		},
	};
}
