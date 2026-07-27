import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import reflectDescription from "../prompts/tools/knowledge-reflect.md" with { type: "text" };
import type { ToolSession } from ".";
import { knowledgeIdentity, requireKnowledgeRuntime } from "./knowledge-shared";

const knowledgeReflectSchema = type({
	"+": "reject",
	purpose: type(
		"'plan-critique' | 'compare-prior-approaches' | 'analyze-recurring-failure' | 'resolve-knowledge-conflict' | 'task-retrospective'",
	).describe("explicit synthesis purpose"),
	question: type("string").describe("question that requires synthesis across prior knowledge"),
	"global?": type("boolean").describe("include user-wide knowledge"),
	"repo?": type("boolean").describe("include current repository knowledge"),
	"task?": type("boolean").describe("include current task knowledge"),
	"include_facts?": type("boolean").describe("include supporting source facts"),
});

export type KnowledgeReflectParams = typeof knowledgeReflectSchema.infer;

export class KnowledgeReflectTool implements AgentTool<typeof knowledgeReflectSchema> {
	readonly name = "knowledge_reflect";
	readonly approval = "read" as const;
	readonly label = "Knowledge Reflect";
	readonly description = reflectDescription;
	readonly parameters = knowledgeReflectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "여러 장기 지식의 제한적 종합 판단";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeReflectTool | null {
		return session.settings.get("knowledge.enabled") ? new KnowledgeReflectTool(session) : null;
	}

	async execute(_id: string, params: KnowledgeReflectParams): Promise<AgentToolResult> {
		const runtime = await requireKnowledgeRuntime(this.session);
		const text = await runtime.reflect({
			purpose: params.purpose,
			question: params.question,
			scope: {
				global: params.global,
				repo: params.repo,
				task: params.task,
			},
			includeFacts: params.include_facts,
			identity: await knowledgeIdentity(this.session),
		});
		return { content: [{ type: "text", text }], details: { purpose: params.purpose } };
	}
}
