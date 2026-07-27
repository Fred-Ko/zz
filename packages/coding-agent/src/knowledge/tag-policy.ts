import type {
	KnowledgeApplicability,
	KnowledgeConfidence,
	KnowledgeDomain,
	KnowledgeEvidenceReference,
	KnowledgeForm,
	KnowledgeIdentity,
	KnowledgePurpose,
	KnowledgeRequestContext,
	KnowledgeScopeName,
	KnowledgeSource,
} from "./types";

export const KNOWLEDGE_SCHEMA_TAG = "schema:zzk-v2";

export interface KnowledgeClassification {
	scope: KnowledgeScopeName;
	form: KnowledgeForm;
	domain: KnowledgeDomain;
	source: KnowledgeSource;
	confidence: KnowledgeConfidence;
	status?: "active" | "contested" | "superseded" | "invalidated";
	applicability?: KnowledgeApplicability;
	request?: KnowledgeRequestContext;
}

export interface KnowledgeTagFilter {
	tags: string[];
	match: "any_strict" | "all_strict";
}

export interface KnowledgeTagGroup {
	and?: KnowledgeTagGroup[];
	or?: KnowledgeTagGroup[];
	not?: KnowledgeTagGroup;
	tags?: string[];
	match?: "any_strict" | "all_strict" | "exact";
}

export interface KnowledgePurposeFilters {
	forms: KnowledgeForm[];
	domains: KnowledgeDomain[];
}

const PURPOSE_FILTERS: Record<KnowledgePurpose, KnowledgePurposeFilters> = {
	"session-orientation": {
		forms: ["preference", "decision", "constraint", "procedure", "pitfall"],
		domains: ["user", "repository", "architecture", "verification", "workflow"],
	},
	"task-planning": {
		forms: ["preference", "decision", "constraint", "procedure", "failure", "pitfall"],
		domains: ["repository", "architecture", "product", "implementation", "verification", "workflow"],
	},
	implementation: {
		forms: ["fact", "decision", "constraint", "procedure", "pitfall"],
		domains: ["repository", "architecture", "implementation", "verification"],
	},
	debugging: {
		forms: ["fact", "procedure", "failure", "pitfall", "lesson"],
		domains: ["implementation", "debugging", "verification", "operations"],
	},
	replanning: {
		forms: ["decision", "constraint", "procedure", "failure", "pitfall", "lesson"],
		domains: ["architecture", "implementation", "debugging", "verification", "workflow"],
	},
	"decision-history": {
		forms: ["decision", "constraint", "lesson"],
		domains: ["repository", "architecture", "product", "implementation", "workflow"],
	},
	"user-preference": {
		forms: ["preference"],
		domains: ["user"],
	},
	"task-resume": {
		forms: ["decision", "constraint", "procedure", "failure", "pitfall", "lesson"],
		domains: ["repository", "architecture", "implementation", "debugging", "verification", "workflow"],
	},
	"completion-review": {
		forms: ["decision", "constraint", "procedure", "failure", "pitfall", "lesson"],
		domains: ["repository", "architecture", "implementation", "debugging", "verification", "workflow"],
	},
};

function normalizeTagValue(value: string, label: string): string {
	const normalized = value
		.trim()
		.toLocaleLowerCase()
		.replace(/[^a-z0-9._/-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
	if (!normalized) throw new Error(`${label} must contain a stable tag value`);
	return normalized;
}

export function normalizeKnowledgeKey(value: string): string {
	const normalized = value
		.trim()
		.toLocaleLowerCase()
		.replace(/[^a-z0-9._:/-]+/g, "-")
		.replace(/\/{2,}/g, "/")
		.replace(/^[-/:]+|[-/:]+$/g, "")
		.slice(0, 240);
	if (!normalized) throw new Error("knowledgeKey must contain a stable logical key");
	return normalized;
}

export function scopeTags(scope: KnowledgeScopeName, identity: KnowledgeIdentity): string[] {
	switch (scope) {
		case "global":
			return ["scope:global"];
		case "repo":
			return ["scope:repo", `repo:${normalizeTagValue(identity.repoId, "repoId")}`];
		case "task":
			if (!identity.taskId) throw new Error("task-scoped knowledge requires taskId");
			return [
				"scope:task",
				`repo:${normalizeTagValue(identity.repoId, "repoId")}`,
				`task:${normalizeTagValue(identity.taskId, "taskId")}`,
			];
	}
}

export function compileRecordTags(classification: KnowledgeClassification, identity: KnowledgeIdentity): string[] {
	const tags = [
		KNOWLEDGE_SCHEMA_TAG,
		...scopeTags(classification.scope, identity),
		`form:${classification.form}`,
		`domain:${classification.domain}`,
		`source:${classification.source}`,
		`confidence:${classification.confidence}`,
		`status:${classification.status ?? "active"}`,
	];
	if (classification.scope !== "global" && identity.branchId) {
		tags.push(`branch-ref:${normalizeTagValue(identity.branchId, "branchId")}`);
	}
	for (const component of classification.applicability?.components ?? []) {
		tags.push(`component:${normalizeTagValue(component, "component")}`);
	}
	for (const platform of classification.applicability?.platforms ?? []) {
		tags.push(`platform:${normalizeTagValue(platform, "platform")}`);
	}
	if (classification.request?.groupId) {
		tags.push(`retain-group:${normalizeTagValue(classification.request.groupId, "retain group")}`);
	}
	return [...new Set(tags)];
}

export function compileObservationScopes(
	classification: KnowledgeClassification,
	identity: KnowledgeIdentity,
): string[][] {
	const base = [
		KNOWLEDGE_SCHEMA_TAG,
		...scopeTags(classification.scope, identity),
		`domain:${classification.domain}`,
		"status:active",
	];
	const components = classification.applicability?.components ?? [];
	if (components.length === 0) return [base];
	return [base, ...components.map(component => [...base, `component:${normalizeTagValue(component, "component")}`])];
}

function valuesGroup(namespace: string, values: readonly string[]): KnowledgeTagGroup | undefined {
	if (values.length === 0) return undefined;
	return {
		tags: values.map(value => `${namespace}:${normalizeTagValue(value, namespace)}`),
		match: "any_strict",
	};
}

export function compileRecallTagGroups(input: {
	purpose: KnowledgePurpose;
	forms?: KnowledgeForm[];
	domains?: KnowledgeDomain[];
	components?: string[];
}): KnowledgeTagGroup[] {
	const defaults = PURPOSE_FILTERS[input.purpose];
	const groups = [
		valuesGroup("form", input.forms ?? defaults.forms),
		valuesGroup("domain", input.domains ?? defaults.domains),
		valuesGroup("component", input.components ?? []),
		{ tags: ["status:active"], match: "all_strict" as const },
	];
	return groups.filter((group): group is KnowledgeTagGroup => group !== undefined);
}

export function sourceFromEvidence(evidence: KnowledgeEvidenceReference[]): KnowledgeSource {
	if (evidence.some(item => item.type === "user-confirmation")) return "user";
	if (evidence.some(item => item.type === "test")) return "test";
	if (evidence.some(item => item.type === "document")) return "document";
	if (evidence.some(item => item.type === "runtime" || item.type === "log" || item.type === "diff")) {
		return "runtime";
	}
	return "agent";
}

export function tagsByNamespace(tags: readonly string[]): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const tag of tags) {
		const separator = tag.indexOf(":");
		if (separator <= 0 || separator === tag.length - 1) continue;
		const namespace = tag.slice(0, separator);
		const values = result.get(namespace) ?? [];
		values.push(tag.slice(separator + 1));
		result.set(namespace, values);
	}
	return result;
}
