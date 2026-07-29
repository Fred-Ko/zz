import type { TaskPlan, TaskPlanStep } from "../../goals/task-lifecycle";
import { resourceClaimSetsConflict } from "./resource-claims";
import type { ZZWStepExecutionContract, ZZWStepExecutor } from "./types";

export interface ZZWReadyStep {
	step: TaskPlanStep;
	execution: ZZWStepExecutionContract;
	criticalDepth: number;
}

export interface ZZWExecutionWaveSelection {
	selected: ZZWReadyStep[];
	deferred: Array<{ stepId: string; reason: string; conflictsWith?: string }>;
}

export interface ZZWExecutionOccupancy {
	stepId: string;
	executor: ZZWStepExecutor;
	resourceClaims: ZZWStepExecutionContract["resourceClaims"];
	countsTowardCapacity?: boolean;
}

function defaultExecutor(step: TaskPlanStep): ZZWStepExecutor {
	return step.kind === "validation" ? "validator" : "primary";
}

export function effectiveStepExecution(step: TaskPlanStep): ZZWStepExecutionContract {
	if (step.execution) {
		return {
			...step.execution,
			resourceClaims: step.execution.resourceClaims.map(claim => ({ ...claim })),
		};
	}
	const executor = defaultExecutor(step);
	return {
		executor,
		resourceClaims: [
			{
				kind: "workspace-path",
				key: ".",
				access: executor === "validator" ? "read" : "exclusive",
			},
		],
		isolation: executor === "validator" ? "none" : "none",
		integration: "none",
		failureDomain: "step",
	};
}

function dependenciesSatisfied(plan: TaskPlan, step: TaskPlanStep): boolean {
	return step.dependsOn.every(dependencyId =>
		plan.steps.some(candidate => candidate.id === dependencyId && candidate.status === "completed"),
	);
}

function criticalDepth(plan: TaskPlan, stepId: string, memo = new Map<string, number>()): number {
	const cached = memo.get(stepId);
	if (cached !== undefined) return cached;
	const dependents = plan.steps.filter(step => step.dependsOn.includes(stepId));
	const depth =
		dependents.length === 0 ? 0 : 1 + Math.max(...dependents.map(step => criticalDepth(plan, step.id, memo)));
	memo.set(stepId, depth);
	return depth;
}

export function readyPlanSteps(plan: TaskPlan): ZZWReadyStep[] {
	const memo = new Map<string, number>();
	const topologicalIndex = new Map(plan.steps.map((step, index) => [step.id, index]));
	return plan.steps
		.filter(step => step.kind !== "milestone" && step.status === "pending" && dependenciesSatisfied(plan, step))
		.map(step => ({
			step,
			execution: effectiveStepExecution(step),
			criticalDepth: criticalDepth(plan, step.id, memo),
		}))
		.sort(
			(left, right) =>
				right.criticalDepth - left.criticalDepth ||
				(topologicalIndex.get(left.step.id) ?? 0) - (topologicalIndex.get(right.step.id) ?? 0) ||
				left.step.id.localeCompare(right.step.id),
		);
}

function executorCapacity(executor: ZZWStepExecutor, options: ZZWSelectWaveOptions): number {
	if (executor === "validator") return options.validationConcurrency;
	if (executor === "subagent-readonly" || executor === "subagent-isolated") return options.subagentConcurrency;
	return 1;
}

function capacityKey(executor: ZZWStepExecutor): ZZWStepExecutor | "subagent" {
	return executor === "subagent-readonly" || executor === "subagent-isolated" ? "subagent" : executor;
}

export interface ZZWSelectWaveOptions {
	mode: "serial" | "validation" | "safe-parallel";
	validationConcurrency: number;
	subagentConcurrency: number;
	requestedStepIds?: readonly string[];
	occupied?: readonly ZZWExecutionOccupancy[];
}

export function selectExecutionWave(plan: TaskPlan, options: ZZWSelectWaveOptions): ZZWExecutionWaveSelection {
	const requested = options.requestedStepIds ? new Set(options.requestedStepIds) : undefined;
	const candidates = readyPlanSteps(plan).filter(candidate => !requested || requested.has(candidate.step.id));
	const selected: ZZWReadyStep[] = [];
	const deferred: ZZWExecutionWaveSelection["deferred"] = [];
	const counts = new Map<ZZWStepExecutor | "subagent", number>();
	for (const occupied of options.occupied ?? []) {
		if (occupied.countsTowardCapacity === false) continue;
		const key = capacityKey(occupied.executor);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	for (const candidate of candidates) {
		const { executor } = candidate.execution;
		if (options.mode === "serial" && selected.length > 0) {
			deferred.push({ stepId: candidate.step.id, reason: "serial-mode" });
			continue;
		}
		if (options.mode === "validation" && executor !== "validator") {
			deferred.push({ stepId: candidate.step.id, reason: "validation-only-mode" });
			continue;
		}
		if (executor === "primary" && selected.length > 0) {
			deferred.push({ stepId: candidate.step.id, reason: "primary-workspace-exclusive" });
			continue;
		}
		if (selected.some(item => item.execution.executor === "primary")) {
			deferred.push({
				stepId: candidate.step.id,
				reason: "primary-workspace-exclusive",
				conflictsWith: selected.find(item => item.execution.executor === "primary")?.step.id,
			});
			continue;
		}
		const snapshotIncompatible = selected.find(item => {
			const selectedExecutor = item.execution.executor;
			return (
				(executor === "validator" && selectedExecutor === "subagent-isolated") ||
				(executor === "subagent-isolated" && selectedExecutor === "validator")
			);
		});
		if (snapshotIncompatible) {
			deferred.push({
				stepId: candidate.step.id,
				reason: "snapshot-freshness-order",
				conflictsWith: snapshotIncompatible.step.id,
			});
			continue;
		}
		const occupiedSnapshotIncompatible = (options.occupied ?? []).find(item => {
			return (
				(executor === "validator" && item.executor === "subagent-isolated") ||
				(executor === "subagent-isolated" && item.executor === "validator")
			);
		});
		if (occupiedSnapshotIncompatible) {
			deferred.push({
				stepId: candidate.step.id,
				reason: "snapshot-freshness-order",
				conflictsWith: occupiedSnapshotIncompatible.stepId,
			});
			continue;
		}
		const key = capacityKey(executor);
		const count = counts.get(key) ?? 0;
		const capacity = Math.max(1, executorCapacity(executor, options));
		if (count >= capacity) {
			deferred.push({ stepId: candidate.step.id, reason: "concurrency-capacity" });
			continue;
		}
		const conflicting = selected.find(item =>
			resourceClaimSetsConflict(candidate.execution.resourceClaims, item.execution.resourceClaims),
		);
		if (conflicting) {
			deferred.push({
				stepId: candidate.step.id,
				reason: "resource-conflict",
				conflictsWith: conflicting.step.id,
			});
			continue;
		}
		const occupiedConflict = (options.occupied ?? []).find(item =>
			resourceClaimSetsConflict(candidate.execution.resourceClaims, item.resourceClaims),
		);
		if (occupiedConflict) {
			deferred.push({
				stepId: candidate.step.id,
				reason: "resource-conflict",
				conflictsWith: occupiedConflict.stepId,
			});
			continue;
		}
		selected.push(candidate);
		counts.set(key, count + 1);
		if (options.mode === "serial") break;
	}

	return { selected, deferred };
}
