import observationsMission from "../prompts/knowledge/bank/observations-mission.md" with { type: "text" };
import reflectMission from "../prompts/knowledge/bank/reflect-mission.md" with { type: "text" };
import retainMission from "../prompts/knowledge/bank/retain-mission.md" with { type: "text" };
import type { KnowledgeBankProfileStatus } from "./types";

export const KNOWLEDGE_BANK_PROFILE_NAME = "zz-engineering";
export const KNOWLEDGE_BANK_PROFILE_VERSION = 2;

export interface KnowledgeBankProfile {
	name: string;
	version: number;
	config: Record<string, unknown>;
	hash: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(record)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, canonical(item)]),
	);
}

export function createKnowledgeBankProfile(): KnowledgeBankProfile {
	const config: Record<string, unknown> = {
		retain_mission: retainMission.trim(),
		reflect_mission: reflectMission.trim(),
		observations_mission: observationsMission.trim(),
		retain_default_strategy: "durable-fact",
		retain_strategies: {
			"durable-fact": {
				retain_extraction_mode: "concise",
			},
			"canonical-document": {
				retain_extraction_mode: "chunks",
				retain_chunk_size: 1_200,
			},
			"reference-document": {
				retain_extraction_mode: "chunks",
				retain_chunk_size: 1_600,
			},
			investigation: {
				retain_extraction_mode: "verbose",
			},
			"append-document": {
				retain_extraction_mode: "chunks",
				retain_chunk_size: 8_000,
			},
		},
		enable_observations: true,
		enable_auto_consolidation: false,
		disposition_skepticism: 5,
		disposition_literalism: 4,
		disposition_empathy: 2,
		mcp_enabled_tools: ["recall", "reflect"],
	};
	return {
		name: KNOWLEDGE_BANK_PROFILE_NAME,
		version: KNOWLEDGE_BANK_PROFILE_VERSION,
		config,
		hash: Bun.hash(JSON.stringify(canonical(config)))
			.toString(16)
			.padStart(16, "0"),
	};
}

export function profileStatus(
	mode: KnowledgeBankProfileStatus["managedConfigMode"],
	appliedHash?: string,
): KnowledgeBankProfileStatus {
	const profile = createKnowledgeBankProfile();
	return {
		name: profile.name,
		version: profile.version,
		hash: profile.hash,
		appliedHash,
		drifted: appliedHash !== profile.hash,
		managedConfigMode: mode,
	};
}
