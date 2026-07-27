import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import description from "../prompts/tools/knowledge-retain-document.md" with { type: "text" };
import type { ToolSession } from ".";
import {
	knowledgeIdentity,
	knowledgeRequestContext,
	requireKnowledgeRuntime,
	withUserRequestEvidence,
} from "./knowledge-shared";

const evidenceSchema = type({
	id: "string",
	type: "'test' | 'log' | 'diff' | 'user-confirmation' | 'document' | 'runtime'",
});

const schema = type({
	"+": "reject",
	content_class: "'canonical-document' | 'reference-document' | 'investigation' | 'append-document'",
	scope: type("'global' | 'repo' | 'task'").describe(
		"durable applicability scope; the current branch is attached automatically as provenance",
	),
	domain:
		"'user' | 'repository' | 'architecture' | 'product' | 'implementation' | 'debugging' | 'verification' | 'workflow' | 'operations'",
	source: "'user' | 'document' | 'test' | 'runtime' | 'external'",
	confidence: "'confirmed' | 'probable' | 'tentative'",
	source_id: type("string").describe("stable source identifier, usually a repository path or canonical external id"),
	title: "string",
	content: "string",
	future_use: "string",
	update_mode: "'replace' | 'append' | 'immutable-revision'",
	request_origin: "'user-explicit' | 'agent-initiated' | 'workflow-review'",
	"source_refs?": evidenceSchema.array(),
	"components?": type("string").array(),
	"platforms?": type("string").array(),
	"valid_from?": "string",
	"valid_until?": "string",
	"occurred_at?": "string",
	"version?": "string",
	"refresh_mental_models?": type(
		"'developer-working-preferences' | 'repo-operating-manual' | 'repo-architecture-decisions' | 'repo-known-pitfalls' | 'repo-debugging-validation-playbook'",
	).array(),
});

export type KnowledgeRetainDocumentParams = typeof schema.infer;

export class KnowledgeRetainDocumentTool implements AgentTool<typeof schema> {
	readonly name = "knowledge_retain_document";
	readonly approval = "write" as const;
	readonly label = "Knowledge Retain Document";
	readonly description = description;
	readonly parameters = schema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "원문 맥락이 필요한 장기 문서 저장";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeRetainDocumentTool | null {
		return session.settings.get("knowledge.enabled") ? new KnowledgeRetainDocumentTool(session) : null;
	}

	async execute(id: string, params: KnowledgeRetainDocumentParams): Promise<AgentToolResult> {
		const runtime = await requireKnowledgeRuntime(this.session);
		const request = knowledgeRequestContext(this.session, params.request_origin, id);
		const receipt = await runtime.retainDocument({
			contentClass: params.content_class,
			scope: params.scope,
			domain: params.domain,
			source: params.source,
			confidence: params.confidence,
			sourceId: params.source_id,
			title: params.title,
			content: params.content,
			futureUse: params.future_use,
			sourceRefs: withUserRequestEvidence(params.source_refs, request),
			updateMode: params.update_mode,
			identity: await knowledgeIdentity(this.session),
			request,
			applicability: {
				components: params.components,
				platforms: params.platforms,
				validFrom: params.valid_from,
				validUntil: params.valid_until,
			},
			occurredAt: params.occurred_at,
			version: params.version,
			refreshMentalModels: params.refresh_mental_models,
		});
		const text =
			receipt.status === "queued"
				? `장기 문서를 요청 그룹 ${receipt.groupId}에 추가했습니다: ${receipt.documentId}`
				: receipt.status === "duplicate"
					? `동일한 문서가 이미 있어 저장하지 않았습니다: ${receipt.reason}`
					: `문서 저장 제안이 거부되었습니다: ${receipt.reason}`;
		return { content: [{ type: "text", text }], details: receipt };
	}
}
