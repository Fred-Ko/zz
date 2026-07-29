import { describe, expect, it } from "bun:test";
import type { TaskPlan, TaskPlanStep } from "@oh-my-pi/pi-coding-agent/goals/task-lifecycle";
import { renderMermaidAsciiSafe } from "@oh-my-pi/pi-utils";
import { buildZZWorkflowPlanDiagram } from "../src/workflow/plan-presentation";

function step(id: string, content: string, dependsOn: string[] = []): TaskPlanStep {
	return {
		id,
		phase: "implementation",
		content,
		status: "pending",
		dependsOn,
		kind: "work",
	};
}

function plan(steps: TaskPlanStep[]): TaskPlan {
	return {
		version: 2,
		status: "current",
		approval: "draft",
		steps,
	};
}

describe("ZZWorkflow Plan DAG presentation", () => {
	it("renders forks and joins from dependsOn rather than display parents", () => {
		const diagram = buildZZWorkflowPlanDiagram(
			plan([
				step("survey", "저장소 조사"),
				step("entities", "엔티티 전환", ["survey"]),
				step("runtime", "런타임 구성", ["survey"]),
				step("integration", "서비스 통합", ["entities", "runtime"]),
			]),
		);

		expect(diagram).not.toBeNull();
		expect(diagram?.source).toContain("n0 --> n1");
		expect(diagram?.source).toContain("n0 --> n2");
		expect(diagram?.source).toContain("n1 --> n3");
		expect(diagram?.source).toContain("n2 --> n3");
		const rendered = renderMermaidAsciiSafe(diagram!.source, { colorMode: "none", paddingX: 2, paddingY: 2 });
		expect(rendered).toContain("저장소 조사");
		expect(rendered).toContain("서비스 통합");
	});

	it("keeps user-authored labels inside one Mermaid node", () => {
		const diagram = buildZZWorkflowPlanDiagram(
			plan([step("unsafe", "닫기] --> injected[위조 | `fence` & escape"), step("verify", "검증", ["unsafe"])]),
		);

		expect(diagram).not.toBeNull();
		expect(diagram?.source.split("\n").filter(line => line.includes(" --> "))).toHaveLength(1);
		expect(renderMermaidAsciiSafe(diagram!.source, { colorMode: "none" })).toContain("injected");
	});

	it("separates inactive lineage from the current execution graph", () => {
		const retired = { ...step("old-validator", "이전 검증"), status: "superseded" as const };
		const current = { ...step("new-validator", "현재 검증"), kind: "validation" as const };
		const diagram = buildZZWorkflowPlanDiagram(plan([retired, current]));

		expect(diagram).toMatchObject({
			visibleStepIds: ["new-validator"],
			hiddenStepIds: ["old-validator"],
		});
		expect(diagram?.source).not.toContain("old-validator");
		expect(diagram?.source).toContain("n0{{");
	});
});
