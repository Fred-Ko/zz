import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import recallDescription from "../prompts/tools/knowledge-recall.md" with { type: "text" };
import type { ToolSession } from ".";
import { knowledgeIdentity, knowledgeRequestContext, requireKnowledgeRuntime } from "./knowledge-shared";

const knowledgeRecallSchema = type({
	"+": "reject",
	purpose: type(
		"'session-orientation' | 'task-planning' | 'implementation' | 'debugging' | 'replanning' | 'decision-history' | 'user-preference' | 'task-resume' | 'completion-review'",
	).describe("why the recalled knowledge is needed"),
	query: type("string").describe("targeted natural-language query"),
	depth: type("'quick' | 'normal' | 'deep' | 'forensic'").describe("recall depth and token budget"),
	"global?": type("boolean").describe("include user-wide knowledge in the current security boundary"),
	"repo?": type("boolean").describe("include knowledge scoped to the current repository"),
	"task?": type("boolean").describe("include current task-scoped knowledge"),
	"include_source_facts?": type("boolean").describe("include source facts when high-risk evidence is required"),
	"include_chunks?": type("boolean").describe("include raw source chunks when document context is required"),
	"forms?": type("'preference' | 'fact' | 'decision' | 'constraint' | 'procedure' | 'failure' | 'pitfall' | 'lesson'")
		.array()
		.describe("optional semantic-form filters"),
	"domains?": type(
		"'user' | 'repository' | 'architecture' | 'product' | 'implementation' | 'debugging' | 'verification' | 'workflow' | 'operations'",
	)
		.array()
		.describe("optional engineering-domain filters"),
	"components?": type("string").array().describe("optional subsystem filters"),
	"request_origin?": type("'user-explicit' | 'agent-initiated' | 'workflow-review'").describe(
		"set user-explicit when directly answering a request to remember or recall",
	),
});

export type KnowledgeRecallParams = typeof knowledgeRecallSchema.infer;

export class KnowledgeRecallTool implements AgentTool<typeof knowledgeRecallSchema> {
	readonly name = "knowledge_recall";
	readonly approval = "read" as const;
	readonly label = "Knowledge Recall";
	readonly description = recallDescription;
	readonly parameters = knowledgeRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "목적과 범위를 지정해 ZZ 장기 지식 조회";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeRecallTool | null {
		return session.settings.get("knowledge.enabled") ? new KnowledgeRecallTool(session) : null;
	}

	async execute(id: string, params: KnowledgeRecallParams): Promise<AgentToolResult> {
		const runtime = await requireKnowledgeRuntime(this.session);
		const result = await runtime.recall({
			purpose: params.purpose,
			query: params.query,
			depth: params.depth,
			scope: {
				global: params.global,
				repo: params.repo,
				task: params.task,
			},
			includeSourceFacts: params.include_source_facts,
			includeChunks: params.include_chunks,
			forms: params.forms,
			domains: params.domains,
			components: params.components,
			request: knowledgeRequestContext(this.session, params.request_origin ?? "agent-initiated", id),
			identity: await knowledgeIdentity(this.session),
		});
		const text =
			result.items.length === 0
				? result.degraded
					? "장기 지식 서비스에 연결하지 못했습니다. 현재 상태만으로 계속 진행하세요."
					: "조건에 맞는 장기 지식이 없습니다."
				: (result.content ?? result.items.map(item => `- ${item.text}`).join("\n"));
		return {
			content: [{ type: "text", text }],
			details: {
				workingSetId: result.id,
				count: result.items.length,
				cached: result.cached,
				degraded: result.degraded,
			},
		};
	}
}
