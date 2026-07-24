import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatNumber, prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import { formatDuration } from "../../slash-commands/helpers/format";
import type { ToolSession } from "../../tools";
import { formatErrorDetail, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { framedBlock, renderStatusLine, truncateToWidth } from "../../tui";
import { completionBudgetReport, remainingTokens } from "../runtime";
import type { Goal, GoalStatus, GoalToolDetails } from "../state";
import { summarizeTaskLifecycle, type TaskLifecycleSummary, type TaskOperationStatus } from "../task-lifecycle";

const goalSchema = type({
	op: type("'create' | 'get' | 'complete' | 'resume' | 'revise' | 'recover' | 'drop'").describe("goal operation"),
	"objective?": type("string").describe("goal objective"),
	"token_budget?": type("number.integer").describe("token budget"),
	"operation_id?": type("string").describe("prepared operation id"),
	"resolution?": type("'committed' | 'failed' | 'compensated'").describe("inspected operation outcome"),
});

export type GoalToolInput = typeof goalSchema.infer;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
	lifecycle: TaskLifecycleSummary | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null,
		lifecycle: null,
	};
}

function validateObjectiveParams(
	params: GoalToolInput,
	op: "create" | "revise",
): { objective: string; tokenBudget?: number } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError(`objective is required when op=${op}`);
	}
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget };
}

function validateRecoveryParams(params: GoalToolInput): {
	operationId: string;
	resolution: Extract<TaskOperationStatus, "committed" | "failed" | "compensated">;
} {
	const operationId = params.operation_id?.trim();
	if (!operationId) throw new ToolError("operation_id is required when op=recover");
	if (!params.resolution) throw new ToolError("resolution is required when op=recover");
	return { operationId, resolution: params.resolution };
}

function assertCompletionReady(lifecycle: TaskLifecycleSummary | null): void {
	if (!lifecycle) return;
	if (lifecycle.pendingOperationIds.length > 0) {
		throw new ToolError(
			`cannot complete task while operation recovery is pending: ${lifecycle.pendingOperationIds.join(", ")}`,
		);
	}
	if (lifecycle.stalePlan || lifecycle.phase === "RECOVERING" || lifecycle.phase === "REPLANNING") {
		throw new ToolError("cannot complete task until the workspace is reconciled and the stale plan is updated");
	}
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "Goal";
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) {
			throw new ToolError("Goal mode is not active.");
		}

		let response: GoalToolResponse;
		if (params.op === "create") {
			const created = await runtime.createGoal(validateObjectiveParams(params, "create"));
			response = buildGoalToolResponse(created.goal);
		} else if (params.op === "revise") {
			const revised = await runtime.reviseGoal(validateObjectiveParams(params, "revise"));
			response = buildGoalToolResponse(revised.goal);
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null);
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal);
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null);
		} else if (params.op === "recover") {
			const { operationId, resolution } = validateRecoveryParams(params);
			const lifecycle = this.#session.getTaskLifecycleRuntime?.();
			if (!lifecycle) throw new ToolError("Task lifecycle is not active.");
			const operation = await lifecycle.resolveOperation(operationId, resolution);
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null);
			response.lifecycle = summarizeTaskLifecycle(lifecycle.state);
			let text = `Operation ${operation.id}: ${operation.status}`;
			if (operation.postStateHash) text += `\nWorkspace state: ${operation.postStateHash}`;
			return {
				content: [{ type: "text", text }],
				details: {
					op: params.op,
					goal: response.goal,
					remainingTokens: response.remainingTokens,
					completionBudgetReport: response.completionBudgetReport,
					lifecycle: response.lifecycle,
					operation,
				},
			};
		} else {
			const lifecycle = this.#session.getTaskLifecycleRuntime?.();
			if (lifecycle) {
				await lifecycle.assertCompletionReady();
			} else {
				assertCompletionReady(summarizeTaskLifecycle(this.#session.getTaskLifecycleState?.()));
			}
			const completed = await runtime.completeGoalFromTool();
			response = buildGoalToolResponse(completed, { includeCompletionReport: true });
		}
		response.lifecycle = summarizeTaskLifecycle(this.#session.getTaskLifecycleState?.());
		let text: string;
		if (response.goal) {
			text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
			if (response.goal.tokenBudget !== undefined) {
				text += ` / ${response.goal.tokenBudget} budget`;
			}
			if (response.remainingTokens !== null) {
				text += `\nRemaining tokens: ${response.remainingTokens}`;
			}
			if (response.completionBudgetReport) {
				text += `\n\n${response.completionBudgetReport}`;
			}
			if (response.lifecycle) {
				text += `\nTask: ${response.lifecycle.taskId}`;
				text += `\nLifecycle: ${response.lifecycle.phase} (spec v${response.lifecycle.specVersion}, plan v${response.lifecycle.planVersion})`;
				text += `\nEpisode: ${response.lifecycle.episodeId}`;
				text += `\nNext workflow action: ${response.lifecycle.requiredNextAction}`;
				text += `\nWrites allowed: ${response.lifecycle.writesAllowed ? "yes" : "no"}`;
				text += `\nVerification current: ${response.lifecycle.verificationFresh ? "yes" : "no"}`;
				if (response.lifecycle.readinessBlockers.length > 0) {
					text += `\nReadiness blockers: ${response.lifecycle.readinessBlockers.join(", ")}`;
				}
				if (response.lifecycle.pendingOperationIds.length > 0) {
					text += `\nRecovery required: ${response.lifecycle.pendingOperationIds.join(", ")}`;
				}
			}
		} else {
			text = "No active goal.";
		}
		return {
			content: [{ type: "text", text }],
			details: {
				op: params.op,
				goal: response.goal,
				remainingTokens: response.remainingTokens,
				completionBudgetReport: response.completionBudgetReport,
				lifecycle: response.lifecycle,
			},
		};
	}
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "revise":
			return "revise";
		case "recover":
			return "recover";
		case "drop":
			return "drop";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
	token_budget?: number;
	operation_id?: string;
	resolution?: "committed" | "failed" | "compensated";
}

export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		if (args.op === "create" && args.token_budget !== undefined) {
			meta.push(`budget ${formatNumber(args.token_budget)}`);
		}
		return new Text(renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(fallbackText || "Goal tool failed", uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			return new Text(
				renderStatusLine({ icon: "warning", title: "Goal", description, meta: ["no active goal"] }, uiTheme),
				0,
				0,
			);
		}

		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.goal", "accent"),
				title: "Goal",
				description,
				badge: { label: goal.status, color: goalBadgeColor(goal.status) },
			},
			uiTheme,
		);

		const lines: string[] = [];
		const objectiveText = truncateToWidth(goal.objective.trim(), TRUNCATE_LENGTHS.LONG);
		lines.push(uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`)));

		const used = formatNumber(goal.tokensUsed);
		const tokensLine =
			goal.tokenBudget !== undefined
				? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
				: `${used} tokens`;
		const metaParts = [tokensLine];
		if (goal.timeUsedSeconds > 0) {
			metaParts.push(`${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`);
		}
		lines.push(uiTheme.fg("dim", metaParts.join(" · ")));

		const report = details?.completionBudgetReport;
		const sections: Array<{ label?: string; lines: string[] }> = [{ lines }];
		if (report) {
			sections.push({ label: "Report", lines: report.split("\n").map(line => uiTheme.fg("muted", line)) });
		}

		return framedBlock(uiTheme, width => ({
			header,
			sections,
			state: "success",
			borderColor: "borderMuted",
			width,
		}));
	},

	mergeCallAndResult: true,
};
