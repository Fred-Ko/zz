import type { UsageStatistics } from "../session/session-entries";
import type { TaskLifecycleSummary, TaskOperation } from "./task-lifecycle";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

/**
 * Selects which runtime owns an active goal.
 *
 * `undefined` is accepted for sessions written before this field existed and
 * is interpreted as the original Goal runtime. New states always persist an
 * explicit controller.
 */
export type GoalController = "goal" | "zzworkflow";

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	controller?: GoalController;
	goal: Goal;
}

export function resolveGoalController(state: GoalModeState | undefined): GoalController {
	return state?.controller === "zzworkflow" ? "zzworkflow" : "goal";
}

export function isZZWorkflowGoalState(
	state: GoalModeState | undefined,
): state is GoalModeState & { controller: "zzworkflow" } {
	return resolveGoalController(state) === "zzworkflow";
}

export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "revise" | "recover" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
	lifecycle?: TaskLifecycleSummary | null;
	operation?: TaskOperation;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";
