import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import curateDescription from "../prompts/tools/knowledge-curate.md" with { type: "text" };
import type { ToolSession } from ".";
import {
	knowledgeIdentity,
	knowledgeRequestContext,
	requireKnowledgeRuntime,
	withUserRequestEvidence,
} from "./knowledge-shared";

const curationEvidenceSchema = type({
	id: "string",
	type: "'test' | 'log' | 'diff' | 'user-confirmation' | 'document' | 'runtime'",
});

const knowledgeCurateSchema = type({
	action: type("'correct' | 'invalidate' | 'restore'").describe("curation action that preserves history"),
	document_id: type("string").describe("stable knowledge document id"),
	reason: type("string").describe("why the current record is wrong, stale, or valid again"),
	"corrected_text?": type("string").describe("replacement text; required for correct"),
	"evidence_refs?": curationEvidenceSchema.array().describe("replacement evidence; required for correct"),
	request_origin: type("'user-explicit' | 'agent-initiated' | 'workflow-review'").describe(
		"origin of this curation request",
	),
});

export type KnowledgeCurateParams = typeof knowledgeCurateSchema.infer;

export class KnowledgeCurateTool implements AgentTool<typeof knowledgeCurateSchema> {
	readonly name = "knowledge_curate";
	readonly approval = "write" as const;
	readonly label = "Knowledge Curate";
	readonly description = curateDescription;
	readonly parameters = knowledgeCurateSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "장기 지식의 교정·무효화·복구";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeCurateTool | null {
		return session.settings.get("knowledge.enabled") ? new KnowledgeCurateTool(session) : null;
	}

	async execute(id: string, params: KnowledgeCurateParams): Promise<AgentToolResult> {
		const runtime = await requireKnowledgeRuntime(this.session);
		const request = knowledgeRequestContext(this.session, params.request_origin, id);
		await runtime.curate({
			action: params.action,
			documentId: params.document_id,
			reason: params.reason,
			correctedText: params.corrected_text,
			evidenceRefs: withUserRequestEvidence(params.evidence_refs, request),
			identity: await knowledgeIdentity(this.session),
			request,
		});
		return {
			content: [{ type: "text", text: `지식 문서 ${params.document_id}: ${params.action} 처리를 완료했습니다.` }],
			details: { action: params.action, documentId: params.document_id },
		};
	}
}
