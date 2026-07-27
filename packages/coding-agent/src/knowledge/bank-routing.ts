import type { KnowledgeConfig } from "./config";
import type { KnowledgeBankNameSource, KnowledgeBankRef, KnowledgeScopeName } from "./types";

const BANK_NAME_LIMIT = 120;

function hash(value: string): string {
	return Bun.hash(value).toString(16).padStart(16, "0");
}

function readable(value: string, fallback: string): string {
	const normalized = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized || fallback;
}

function displayName(value: string): string {
	return value.length <= BANK_NAME_LIMIT ? value : `${value.slice(0, BANK_NAME_LIMIT - 1).trimEnd()}…`;
}

export interface CreateKnowledgeBankRefsInput {
	config: KnowledgeConfig;
	repositoryId: string;
	repositoryDisplayName: string;
	repositoryNameSource: KnowledgeBankNameSource;
}

export function createKnowledgeBankRefs(input: CreateKnowledgeBankRefsInput): {
	global: KnowledgeBankRef;
	repository: KnowledgeBankRef;
} {
	const user = readable(input.config.userId, "default");
	const boundary = readable(input.config.securityBoundary, "personal");
	const repositoryName = readable(input.config.repositoryDisplayName ?? input.repositoryDisplayName, "Repository");
	const repositoryIdHash = hash(input.repositoryId);
	const nameSource = input.config.repositoryDisplayName ? "project-config" : input.repositoryNameSource;
	const localSuffix = nameSource === "local-directory" ? ` · ${repositoryIdHash.slice(0, 6)}` : "";
	return {
		global: {
			kind: "global",
			bankId: `zz-global-v1-${hash(`${input.config.userId}:${input.config.securityBoundary}`)}`,
			displayName: displayName(`ZZ Global · ${user} · ${boundary}`),
			nameSource: "generated",
		},
		repository: {
			kind: "repository",
			bankId: `zz-repo-v1-${hash(`${input.config.userId}:${input.config.securityBoundary}:${input.repositoryId}`)}`,
			displayName: displayName(`ZZ Repo · ${repositoryName}${localSuffix} · ${boundary}`),
			nameSource,
			repositoryId: input.repositoryId,
		},
	};
}

export function bankForScope(
	banks: { global: KnowledgeBankRef; repository: KnowledgeBankRef },
	scope: KnowledgeScopeName,
): KnowledgeBankRef {
	return scope === "global" ? banks.global : banks.repository;
}
