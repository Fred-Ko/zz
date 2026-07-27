import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import retainDescription from "../prompts/tools/knowledge-retain.md" with { type: "text" };
import type { ToolSession } from ".";
import {
	knowledgeIdentity,
	knowledgeRequestContext,
	requireKnowledgeRuntime,
	withUserRequestEvidence,
} from "./knowledge-shared";

const knowledgeEvidenceSchema = type({
	id: type("string").describe("evidence identifier from Workflow, test, document, diff, log, or runtime"),
	type: type("'test' | 'log' | 'diff' | 'user-confirmation' | 'document' | 'runtime'").describe("evidence type"),
});

const knowledgeRetainSchema = type({
	"+": "reject",
	scope: type("'global' | 'repo' | 'task'").describe(
		"durable applicability scope; the current branch is attached automatically as provenance",
	),
	form: type(
		"'preference' | 'fact' | 'decision' | 'constraint' | 'procedure' | 'failure' | 'pitfall' | 'lesson'",
	).describe("semantic form of the record"),
	domain: type(
		"'user' | 'repository' | 'architecture' | 'product' | 'implementation' | 'debugging' | 'verification' | 'workflow' | 'operations'",
	).describe("engineering domain used for targeted recall"),
	source: type("'user' | 'document' | 'test' | 'runtime' | 'external' | 'agent'").describe("actual provenance class"),
	confidence: type("'confirmed' | 'probable' | 'tentative'").describe("confidence supported by the cited evidence"),
	knowledge_key: type("string").describe("stable logical key independent from the physical document id"),
	statement: type("string").describe("self-contained durable knowledge"),
	future_use: type("string").describe("how a future task will use this knowledge"),
	request_origin: type("'user-explicit' | 'agent-initiated' | 'workflow-review'").describe(
		"whether this call answers an explicit user request or an agent/workflow review",
	),
	"source_refs?": knowledgeEvidenceSchema
		.array()
		.describe("evidence references; the current user message is attached automatically for user-explicit requests"),
	"content_class?": type("'durable-fact' | 'investigation'").describe("Hindsight extraction strategy"),
	"components?": type("string").array().describe("affected subsystem names"),
	"platforms?": type("string").array().describe("platform applicability"),
	"valid_from?": type("string").describe("ISO validity start"),
	"valid_until?": type("string").describe("ISO validity end"),
	"occurred_at?": type("string").describe("ISO timestamp for the source event"),
	"document_id?": type("string").describe("stable physical id when replacing a mutable record"),
	"supersedes?": type("string").describe("document id superseded by this record"),
	"refresh_mental_models?": type(
		"'developer-working-preferences' | 'repo-operating-manual' | 'repo-architecture-decisions' | 'repo-known-pitfalls' | 'repo-debugging-validation-playbook'",
	)
		.array()
		.describe("refresh only summaries whose conclusion may change because of this verified record"),
});

export type KnowledgeRetainParams = typeof knowledgeRetainSchema.infer;

export class KnowledgeRetainTool implements AgentTool<typeof knowledgeRetainSchema> {
	readonly name = "knowledge_retain";
	readonly approval = "write" as const;
	readonly label = "Knowledge Retain";
	readonly description = retainDescription;
	readonly parameters = knowledgeRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "검증된 장기 지식 저장 제안";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeRetainTool | null {
		return session.settings.get("knowledge.enabled") ? new KnowledgeRetainTool(session) : null;
	}

	async execute(id: string, params: KnowledgeRetainParams): Promise<AgentToolResult> {
		const runtime = await requireKnowledgeRuntime(this.session);
		const request = knowledgeRequestContext(this.session, params.request_origin, id);
		const receipt = await runtime.retain({
			contentClass: params.content_class,
			scope: params.scope,
			form: params.form,
			domain: params.domain,
			source: params.source,
			confidence: params.confidence,
			knowledgeKey: params.knowledge_key,
			statement: params.statement,
			futureUse: params.future_use,
			sourceRefs: withUserRequestEvidence(params.source_refs, request),
			occurredAt: params.occurred_at,
			documentId: params.document_id,
			supersedes: params.supersedes,
			applicability: {
				components: params.components,
				platforms: params.platforms,
				validFrom: params.valid_from,
				validUntil: params.valid_until,
			},
			request,
			refreshMentalModels: params.refresh_mental_models,
			identity: await knowledgeIdentity(this.session),
		});
		const text =
			receipt.status === "queued"
				? `장기 지식을 요청 그룹 ${receipt.groupId}에 추가했습니다: ${receipt.documentId}`
				: receipt.status === "duplicate"
					? `동일한 지식이 이미 있어 저장하지 않았습니다: ${receipt.reason}`
					: `지식 저장 제안이 거부되었습니다: ${receipt.reason}`;
		return { content: [{ type: "text", text }], details: receipt };
	}
}
