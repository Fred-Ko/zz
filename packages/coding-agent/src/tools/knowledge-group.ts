import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import description from "../prompts/tools/knowledge-group.md" with { type: "text" };
import type { ToolSession } from ".";
import { requireKnowledgeRuntime } from "./knowledge-shared";

const schema = type({
	action: "'list' | 'invalidate' | 'restore'",
	"group_id?": type("string").describe("required for invalidate and restore"),
	"reason?": type("string").describe("required for invalidate and restore"),
	"limit?": type("number.integer > 0").describe("maximum groups returned by list"),
});

export type KnowledgeGroupParams = typeof schema.infer;

export class KnowledgeGroupTool implements AgentTool<typeof schema> {
	readonly name = "knowledge_group";
	readonly approval = (args: unknown) =>
		isRecord(args) && args.action === "list" ? ("read" as const) : ("write" as const);
	readonly label = "Knowledge Group";
	readonly description = description;
	readonly parameters = schema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "요청 단위 지식 그룹 조회·무효화·복구";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeGroupTool | null {
		return session.settings.get("knowledge.enabled") ? new KnowledgeGroupTool(session) : null;
	}

	async execute(_id: string, params: KnowledgeGroupParams): Promise<AgentToolResult> {
		const runtime = await requireKnowledgeRuntime(this.session);
		if (params.action === "list") {
			const groups = await runtime.listGroups(params.limit);
			const text =
				groups.length === 0
					? "이 저장소에서 생성된 지식 요청 그룹이 없습니다."
					: groups
							.map(
								group =>
									`${group.id} · ${group.status} · ${group.memberCount}개 · ${group.origin} · ${group.createdAt}`,
							)
							.join("\n");
			return { content: [{ type: "text", text }], details: { groups } };
		}
		if (!params.group_id || !params.reason?.trim()) {
			throw new Error(`${params.action}에는 group_id와 reason이 필요합니다.`);
		}
		await runtime.curateGroup({
			action: params.action,
			groupId: params.group_id,
			reason: params.reason,
		});
		return {
			content: [{ type: "text", text: `지식 요청 그룹 ${params.group_id}: ${params.action} 처리를 완료했습니다.` }],
			details: { action: params.action, groupId: params.group_id },
		};
	}
}
