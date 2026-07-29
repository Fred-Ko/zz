import { Container, Markdown, Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { TaskPlan } from "../goals/task-lifecycle";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui";
import { buildZZWorkflowPlanDiagram } from "../workflow/plan-presentation";
import { renderDefaultToolExecution } from "./default-renderer";
import { previewLine, TRUNCATE_LENGTHS } from "./render-utils";

interface WorkflowPlanRendererResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

function isTaskPlan(value: unknown): value is TaskPlan {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TaskPlan>;
	return (
		typeof candidate.version === "number" && Array.isArray(candidate.steps) && typeof candidate.status === "string"
	);
}

function resultText(result: WorkflowPlanRendererResult): string {
	return result.content.find(item => item.type === "text" && typeof item.text === "string")?.text ?? "";
}

function createWorkflowPlanRenderer(title: string) {
	return {
		mergeCallAndResult: true,
		renderCall(_args: unknown, options: RenderResultOptions, uiTheme: Theme) {
			return new Text(
				renderStatusLine({ icon: "pending", spinnerFrame: options.spinnerFrame, title }, uiTheme),
				0,
				0,
			);
		},
		renderResult(result: WorkflowPlanRendererResult, options: RenderResultOptions, uiTheme: Theme, args?: unknown) {
			const plan = isTaskPlan(result.details) ? result.details : undefined;
			if (!plan) {
				return renderDefaultToolExecution(
					{
						label: title,
						args,
						result: { output: resultText(result), isError: result.isError },
						options,
					},
					uiTheme,
				);
			}

			const diagram = buildZZWorkflowPlanDiagram(plan);
			const container = new Container();
			container.addChild(
				new Text(
					renderStatusLine(
						{
							icon: plan.approval === "approved" ? "success" : "done",
							title,
							description: `v${plan.version} · ${plan.approval ?? "draft"} · ${plan.steps.length}단계`,
						},
						uiTheme,
					),
					0,
					0,
				),
			);
			if (diagram) {
				container.addChild(new Markdown(diagram.markdown, 0, 0, getMarkdownTheme()));
			}

			const footer = [
				diagram && diagram.hiddenStepIds.length > 0
					? uiTheme.fg("dim", `비활성 계보 ${diagram.hiddenStepIds.length}개는 그래프에서 제외`)
					: undefined,
				plan.approval === "approved"
					? uiTheme.fg("success", "기존 승인 유지 · 실행 계속")
					: `${uiTheme.fg("warning", "사용자 승인 필요")} · ${uiTheme.fg("accent", "/zzw approve-plan")}`,
			].filter((line): line is string => line !== undefined);
			if (options.expanded) {
				footer.push("", uiTheme.fg("dim", "단계 상세"));
				for (const step of plan.steps) {
					footer.push(
						`- [${step.status}] ${previewLine(step.id, TRUNCATE_LENGTHS.TITLE)} · ${previewLine(step.content, TRUNCATE_LENGTHS.LONG)}`,
					);
				}
			}
			container.addChild(new Text(footer.join("\n"), 0, 0));
			return container;
		},
	};
}

export const zzwProposePlanRenderer = createWorkflowPlanRenderer("ZZWorkflow Plan Proposal");
export const zzwPatchPlanRenderer = createWorkflowPlanRenderer("ZZWorkflow Plan Patch");
