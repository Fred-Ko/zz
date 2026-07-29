import { beforeEach, describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { TaskPlan } from "@oh-my-pi/pi-coding-agent/goals/task-lifecycle";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { zzwProposePlanRenderer } from "@oh-my-pi/pi-coding-agent/tools/workflow-plan-renderer";

const options: RenderResultOptions = { expanded: false, isPartial: false };

describe("ZZWorkflow Plan tool renderer", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const activeTheme = await getThemeByName("dark");
		expect(activeTheme).toBeDefined();
		setThemeInstance(activeTheme!);
	});

	it("shows the proposed DAG without requiring tool-output expansion", async () => {
		const activeTheme = (await getThemeByName("dark"))!;
		const plan: TaskPlan = {
			version: 3,
			status: "current",
			approval: "draft",
			steps: [
				{
					id: "survey",
					phase: "discovery",
					content: "저장소 조사",
					status: "pending",
					dependsOn: [],
					kind: "work",
				},
				{
					id: "verify",
					phase: "verification",
					content: "전체 검증",
					status: "pending",
					dependsOn: ["survey"],
					kind: "validation",
				},
			],
		};

		const component = zzwProposePlanRenderer.renderResult(
			{ content: [{ type: "text", text: "proposal" }], details: plan },
			options,
			activeTheme,
		);
		const rendered = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(rendered).toContain("ZZWorkflow Plan Proposal");
		expect(rendered).toContain("저장소 조사");
		expect(rendered).toContain("전체 검증");
		expect(rendered).toContain("/zzw approve-plan");
		expect(rendered).not.toContain("```mermaid");
	});
});
