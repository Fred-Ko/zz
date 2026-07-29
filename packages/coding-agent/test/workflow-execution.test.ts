import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	captureTaskWorkspace,
	summarizeTaskLifecycle,
	TASK_OPERATION_ENTRY_TYPE,
	type TaskLifecycleHost,
	type TaskLifecycleJournalEntry,
	TaskLifecycleRuntime,
	type TaskPlan,
	type TaskPlanStepProposal,
	TaskPlanValidationError,
	type TaskWorkspaceSnapshot,
} from "@oh-my-pi/pi-coding-agent/goals/task-lifecycle";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ZZWorkflowGetStateTool } from "@oh-my-pi/pi-coding-agent/tools/workflow-control";
import { ZZWorkflowExecuteWaveTool } from "@oh-my-pi/pi-coding-agent/tools/workflow-execution";
import { $ } from "bun";
import { loadZZWorkflowConfig } from "../src/workflow/config";
import {
	buildZZWorkflowModelChoices,
	resolveZZWorkflowExecutionModels,
	resourceClaimSetsConflict,
	selectExecutionWave,
	type ZZWExecutionSettings,
	type ZZWPlanImpact,
	ZZWResourceClaimLock,
} from "../src/workflow/execution";

function workspace(): TaskWorkspaceSnapshot {
	return {
		workspaceId: "workspace-1",
		repoId: "repo-1",
		cwd: "/repo",
		repoRoot: "/repo",
		branch: "main",
		headCommit: "abc",
		dirtyTreeHash: "clean",
		dependencyLockHash: "lock",
		environmentHash: "env",
		capturedAt: 1,
	};
}

function goal(): Goal {
	return {
		id: "parallel-task",
		objective: [
			"## Objective",
			"Run independent work safely.",
			"## Success criteria",
			"- All checks pass.",
			"## Verification",
			"- Run the approved checks.",
		].join("\n"),
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	};
}

function noPlanImpact(): ZZWPlanImpact {
	return {
		level: "none",
		kind: "none",
		reason: "",
		evidence: [],
		affectedStepIds: [],
		contradictedAssumptionIds: [],
		proposedChanges: [],
	};
}

function enabledWorkUnitSettings(): ZZWExecutionSettings {
	return {
		mode: "safe-parallel",
		validationConcurrency: 4,
		subagentConcurrency: 3,
		isolationMode: "auto",
		preserveFailedLanes: true,
		rollingEpoch: true,
		workUnits: { enabled: true, model: "openai/test-work-unit:high" },
		adversarialReview: { enabled: true, model: "openai/test-reviewer:medium", maxRepairAttempts: 1 },
	};
}

function harness(overrides: Partial<TaskLifecycleHost> = {}) {
	const entries: TaskLifecycleJournalEntry[] = [];
	const syncReasons: string[] = [];
	let id = 0;
	const host: TaskLifecycleHost = {
		getSessionId: () => "session-1",
		getCwd: () => "/repo",
		getEntries: () => entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		ensureOnDisk: async () => undefined,
		flush: async () => undefined,
		captureWorkspace: async () => workspace(),
		syncZZWorkflowState: async (_state, reason) => {
			syncReasons.push(reason);
		},
		syncZZWorkflowOperation: async (_state, _operation, reason) => {
			syncReasons.push(reason);
		},
		now: () => 1,
		mintId: kind => `${kind}-${++id}`,
		...overrides,
	};
	return { entries, host, syncReasons };
}

function workStep(overrides: Partial<TaskPlanStepProposal> = {}): TaskPlanStepProposal {
	return {
		id: "work",
		phase: "Implementation",
		content: "Implement the change",
		kind: "work",
		dependsOn: [],
		expectedEffects: ["Source changes"],
		allowedTools: ["read", "edit", "write", "bash"],
		allowedTargets: ["src"],
		postconditions: ["Implementation exists"],
		successConditionIds: [],
		verificationIds: [],
		validators: [],
		rerunPolicy: "safe",
		riskClass: "low",
		...overrides,
	};
}

function validationStep(validators = ["bun check"]): TaskPlanStepProposal {
	return {
		id: "verify",
		phase: "Validation",
		content: "Run independent checks",
		kind: "validation",
		dependsOn: ["work"],
		expectedEffects: [],
		allowedTools: ["bash"],
		allowedTargets: [],
		postconditions: ["Checks pass"],
		successConditionIds: ["SC-1"],
		verificationIds: ["V-1"],
		validators,
		rerunPolicy: "safe",
		riskClass: "low",
		execution: {
			executor: "validator",
			resourceClaims: [{ kind: "workspace-path", key: ".", access: "read" }],
			isolation: "none",
			integration: "none",
			failureDomain: "step",
		},
	};
}

function workUnitStep(): TaskPlanStepProposal {
	return workStep({
		execution: {
			executor: "subagent-isolated",
			delegationAssessment: {
				decision: "delegate-isolated",
				reasonCode: "bounded-isolated-write",
				rationale: "The two bounded source areas can be changed and verified independently.",
			},
			resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
			isolation: "required",
			integration: "patch",
			failureDomain: "step",
			workUnits: [
				{
					id: "mechanical-unit",
					content: "Apply a bounded mechanical edit",
					expectedEffects: ["Mechanical source change"],
					allowedTools: ["read", "edit"],
					allowedTargets: ["src/mechanical"],
					postconditions: ["Mechanical check passes"],
					resourceClaims: [{ kind: "workspace-path", key: "src/mechanical", access: "write" }],
					validators: ["bun test mechanical"],
					capability: "mechanical",
				},
				{
					id: "reasoning-unit",
					content: "Resolve a local design decision",
					expectedEffects: ["Local source change"],
					allowedTools: ["read", "edit"],
					allowedTargets: ["src/reasoning"],
					postconditions: ["Local contract holds"],
					resourceClaims: [{ kind: "workspace-path", key: "src/reasoning", access: "write" }],
					validators: [],
					capability: "local-reasoning",
				},
			],
		},
	});
}

async function createRuntime(steps: TaskPlanStepProposal[], hostOverrides: Partial<TaskLifecycleHost> = {}) {
	const state = harness(hostOverrides);
	const runtime = new TaskLifecycleRuntime(state.host);
	await runtime.handleGoalEvent({ type: "created", goal: goal() });
	await runtime.proposePlan({ basedOnSpecVersion: 1, steps });
	await runtime.approvePlan();
	return { ...state, runtime };
}

async function completePrimaryWork(runtime: TaskLifecycleRuntime): Promise<void> {
	const operation = await runtime.prepareOperation({
		toolCallId: "work-call",
		toolName: "write",
		tier: "write",
		args: { path: "src/change.ts" },
	});
	await runtime.settleOperation("work-call", false);
	const evidenceId = runtime.state?.evidence.find(item => item.operationId === operation?.id)?.id;
	if (!evidenceId) throw new Error("missing work evidence");
	await runtime.reportStepResult({
		stepId: "work",
		status: "completed",
		evidenceIds: [evidenceId],
		unexpectedEffects: [],
		classification: "matched",
	});
}

describe("ZZWorkflow execution scheduler", () => {
	it("requires an explicit delegation decision when Work Unit delegation is enabled", async () => {
		const state = harness({ executionSettings: enabledWorkUnitSettings });
		const runtime = new TaskLifecycleRuntime(state.host);
		await runtime.handleGoalEvent({ type: "created", goal: goal() });

		let caught: unknown;
		try {
			await runtime.proposePlan({ basedOnSpecVersion: 1, steps: [workStep(), validationStep()] });
		} catch (error) {
			caught = error;
		}

		if (!(caught instanceof TaskPlanValidationError)) throw caught;
		expect(caught.issues).toContainEqual({
			code: "DELEGATION_ASSESSMENT_MISSING",
			message: "work 단계는 Work Unit 활성 정책에 따라 위임 또는 Primary 유지 판단을 명시해야 합니다.",
			stepId: "work",
		});
	});

	it("accepts an explicit Primary retention decision and exposes the active execution policy", async () => {
		const primary = workStep({
			execution: {
				executor: "primary",
				delegationAssessment: {
					decision: "retain-primary",
					reasonCode: "cross-cutting-reasoning",
					rationale: "The step owns a cross-cutting contract decision.",
				},
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "exclusive" }],
				isolation: "none",
				integration: "none",
				failureDomain: "step",
			},
		});
		const { runtime } = await createRuntime([primary, validationStep()], {
			executionSettings: enabledWorkUnitSettings,
		});
		const summary = summarizeTaskLifecycle(runtime.state, "safe-parallel");

		expect(summary).toMatchObject({
			delegatedStepIds: [],
			retainedPrimaryStepIds: ["work"],
			unassessedDelegationStepIds: [],
			declaredWorkUnitCount: 0,
		});
		expect(runtime.buildContext()).toContain("Work Unit delegation enabled: true");
		expect(runtime.buildContext()).toContain("Adversarial review enabled: true");
	});

	it("returns the live execution policy with authoritative specification reads", async () => {
		const { runtime } = await createRuntime([workUnitStep(), validationStep()]);
		const settings = Settings.isolated({
			"zzworkflow.execution.mode": "safe-parallel",
			"zzworkflow.execution.workUnits.enabled": true,
			"zzworkflow.execution.workUnits.model": "openai/test-work-unit:high",
			"zzworkflow.execution.adversarialReview.enabled": true,
			"zzworkflow.execution.adversarialReview.model": "openai/test-reviewer:medium",
		});
		const session = {
			getTaskLifecycleRuntime: () => runtime,
			settings,
		} as ToolSession;

		const result = await new ZZWorkflowGetStateTool(session).execute("state", { detail: "spec" });

		expect(result.details).toMatchObject({
			executionPolicy: {
				mode: "safe-parallel",
				workUnits: { enabled: true, model: "openai/test-work-unit:high" },
				adversarialReview: { enabled: true, model: "openai/test-reviewer:medium" },
			},
		});
	});

	it("routes a legacy pending Plan through delegation assessment before another mutation", async () => {
		const executionSettings = enabledWorkUnitSettings();
		executionSettings.workUnits.enabled = false;
		const { runtime } = await createRuntime([workStep(), validationStep()], {
			executionSettings: () => executionSettings,
		});
		executionSettings.workUnits.enabled = true;

		expect(summarizeTaskLifecycle(runtime.state, "safe-parallel", true)?.requiredNextAction).toBe(
			"assess_delegation_and_patch_plan",
		);
		await expect(
			runtime.prepareOperation({
				toolCallId: "legacy-write",
				toolName: "write",
				tier: "write",
				args: { path: "src/change.ts" },
			}),
		).rejects.toThrow("Work Unit 위임 판단이 누락된 pending 단계");
	});

	it("loads Work Unit and adversarial review controls as independent settings", () => {
		const settings = Settings.isolated({
			"zzworkflow.execution.workUnits.enabled": true,
			"zzworkflow.execution.workUnits.model": "openai/test-work-unit:high",
			"zzworkflow.execution.adversarialReview.enabled": false,
			"zzworkflow.execution.adversarialReview.model": "openai/test-reviewer:medium",
		});

		const config = loadZZWorkflowConfig(settings).execution;

		expect(config.workUnits).toMatchObject({ enabled: true, model: "openai/test-work-unit:high" });
		expect(config.adversarialReview).toMatchObject({ enabled: false, model: "openai/test-reviewer:medium" });
	});

	it("keeps Work Unit and reviewer model defaults neutral", () => {
		const config = loadZZWorkflowConfig(Settings.isolated()).execution;

		expect(config.workUnits).toMatchObject({ model: "*" });
		expect(config.adversarialReview.model).toBe("*");
	});

	it("offers only the current session model and authenticated model selectors", () => {
		const choices = buildZZWorkflowModelChoices(
			[
				{
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					supportedEfforts: [Effort.Low, Effort.Medium, Effort.High],
				},
				{ provider: "openrouter", id: "z-ai/glm-5", supportedEfforts: [Effort.High, Effort.Max] },
				{ provider: "openrouter", id: "z-ai/glm-5", supportedEfforts: [Effort.High, Effort.Max] },
			],
			"openai-codex/gpt-5.6-sol",
		);

		expect(choices.map(choice => choice.value)).toEqual([
			"*",
			"*:low",
			"*:medium",
			"*:high",
			"openai-codex/gpt-5.6-sol",
			"openai-codex/gpt-5.6-sol:low",
			"openai-codex/gpt-5.6-sol:medium",
			"openai-codex/gpt-5.6-sol:high",
			"openrouter/z-ai/glm-5",
			"openrouter/z-ai/glm-5:high",
			"openrouter/z-ai/glm-5:max",
		]);
		expect(choices[0]?.description).toContain("openai-codex/gpt-5.6-sol");
	});

	it("resolves ZZW model contracts to exact available models and rejects stale selectors", () => {
		const base = {
			availableModels: [
				{
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					supportedEfforts: [Effort.Low, Effort.Medium, Effort.High],
				},
				{ provider: "openrouter", id: "z-ai/glm-5", supportedEfforts: [Effort.High, Effort.Max] },
			],
			activeModel: {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				supportedEfforts: [Effort.Low, Effort.Medium, Effort.High],
			},
			workUnitModel: "*:medium",
			adversarialReviewerModel: "openrouter/z-ai/glm-5:max",
		};

		expect(resolveZZWorkflowExecutionModels(base)).toEqual({
			workUnitModel: "openai-codex/gpt-5.6-sol:medium",
			adversarialReviewerModel: "openrouter/z-ai/glm-5:max",
		});
		expect(() => resolveZZWorkflowExecutionModels({ ...base, workUnitModel: "@smol" })).toThrow(
			"선택할 수 없는 모델",
		);
		expect(() => resolveZZWorkflowExecutionModels({ ...base, workUnitModel: "anthropic/claude-missing" })).toThrow(
			"anthropic/claude-missing",
		);
		expect(() =>
			resolveZZWorkflowExecutionModels({ ...base, workUnitModel: "openrouter/z-ai/glm-5:medium" }),
		).toThrow("effort");
	});

	it("treats overlapping hierarchical writes as conflicts but permits read/read", () => {
		expect(
			resourceClaimSetsConflict(
				[{ kind: "workspace-path", key: "src", access: "write" }],
				[{ kind: "workspace-path", key: "src/auth/session.ts", access: "read" }],
			),
		).toBe(true);
		expect(
			resourceClaimSetsConflict(
				[{ kind: "workspace-path", key: "src", access: "read" }],
				[{ kind: "workspace-path", key: "src/auth", access: "read" }],
			),
		).toBe(false);
	});

	it("selects a deterministic conflict-free wave and shares the subagent capacity", () => {
		const base = workStep({ id: "base" });
		const plan: TaskPlan = {
			version: 1,
			status: "current",
			approval: "approved",
			steps: [
				{ ...base, status: "completed" },
				{
					...workStep({ id: "left", dependsOn: ["base"] }),
					status: "pending",
					execution: {
						executor: "subagent-isolated",
						resourceClaims: [{ kind: "workspace-path", key: "src/left", access: "write" }],
						isolation: "required",
						integration: "patch",
						failureDomain: "step",
					},
				},
				{
					...workStep({ id: "right", dependsOn: ["base"] }),
					status: "pending",
					execution: {
						executor: "subagent-readonly",
						resourceClaims: [{ kind: "workspace-path", key: "src/right", access: "read" }],
						isolation: "none",
						integration: "none",
						failureDomain: "step",
					},
				},
			],
		};
		const limited = selectExecutionWave(plan, {
			mode: "safe-parallel",
			validationConcurrency: 4,
			subagentConcurrency: 1,
		});
		expect(limited.selected.map(item => item.step.id)).toEqual(["left"]);
		expect(limited.deferred).toEqual([{ stepId: "right", reason: "concurrency-capacity" }]);

		const serial = selectExecutionWave(plan, {
			mode: "serial",
			validationConcurrency: 4,
			subagentConcurrency: 4,
		});
		expect(serial.selected.map(item => item.step.id)).toEqual(["left"]);
		expect(serial.deferred).toEqual([]);
	});

	it("separates isolated writes from validators so integration cannot stale same-Wave evidence", () => {
		const base = workStep({ id: "base" });
		const plan: TaskPlan = {
			version: 1,
			status: "current",
			approval: "approved",
			steps: [
				{ ...base, status: "completed" },
				{
					...workStep({ id: "isolated", dependsOn: ["base"] }),
					status: "pending",
					execution: {
						executor: "subagent-isolated",
						resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
						isolation: "required",
						integration: "patch",
						failureDomain: "step",
					},
				},
				{
					...validationStep(),
					id: "independent-verify",
					dependsOn: ["base"],
					status: "pending",
				},
			],
		};

		const selection = selectExecutionWave(plan, {
			mode: "safe-parallel",
			validationConcurrency: 4,
			subagentConcurrency: 2,
		});

		expect(selection.selected.map(item => item.step.id)).toEqual(["isolated"]);
		expect(selection.deferred).toEqual([
			{ stepId: "independent-verify", reason: "snapshot-freshness-order", conflictsWith: "isolated" },
		]);
	});

	it("admits disjoint Lane work while keeping conflicting claims queued", async () => {
		const lock = new ZZWResourceClaimLock();
		const firstGate = Promise.withResolvers<void>();
		const entered: string[] = [];
		const first = lock.run("first", [{ kind: "workspace-path", key: "src/auth", access: "write" }], async () => {
			entered.push("first");
			await firstGate.promise;
		});
		const conflicting = lock.run(
			"conflicting",
			[{ kind: "workspace-path", key: "src/auth/session.ts", access: "read" }],
			async () => {
				entered.push("conflicting");
			},
		);
		const disjoint = lock.run(
			"disjoint",
			[{ kind: "workspace-path", key: "src/catalog", access: "write" }],
			async () => {
				entered.push("disjoint");
			},
		);
		await disjoint;
		expect(entered).toEqual(["first", "disjoint"]);
		firstGate.resolve();
		await Promise.all([first, conflicting]);
		expect(entered).toEqual(["first", "disjoint", "conflicting"]);
	});
});

describe("ZZWorkflow execution journal", () => {
	it("keeps explicit Work Units dormant when delegation is disabled", async () => {
		const { runtime } = await createRuntime([workUnitStep(), validationStep()]);

		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 2,
			workUnitsEnabled: false,
			adversarialReviewEnabled: true,
		});

		expect(prepared.lanes).toHaveLength(1);
		expect(prepared.lanes[0]).toMatchObject({
			workUnitId: undefined,
			modelSelector: "*",
			reviewRequired: true,
		});
	});

	it("keeps Work Unit decomposition and review independent from parallel scheduling", async () => {
		const { runtime } = await createRuntime([workUnitStep(), validationStep()]);

		const prepared = await runtime.prepareExecutionWave({
			mode: "serial",
			validationConcurrency: 4,
			subagentConcurrency: 4,
			workUnitsEnabled: true,
			adversarialReviewEnabled: true,
		});

		expect(prepared.lanes.map(lane => [lane.workUnitId, lane.reviewRequired])).toEqual([
			["mechanical-unit", true],
			["reasoning-unit", true],
		]);
	});

	it("can review an explicitly mechanical isolated Step without Work Unit decomposition", async () => {
		const step = workUnitStep();
		if (!step.execution) throw new Error("missing execution contract");
		step.execution.capability = "mechanical";
		const { runtime } = await createRuntime([step, validationStep()]);

		const prepared = await runtime.prepareExecutionWave({
			mode: "serial",
			validationConcurrency: 1,
			subagentConcurrency: 1,
			workUnitsEnabled: false,
			adversarialReviewEnabled: true,
		});

		expect(prepared.lanes).toHaveLength(1);
		expect(prepared.lanes[0]).toMatchObject({ workUnitId: undefined, reviewRequired: true });
	});

	it("uses one selected model and effort while reviewing every isolated Work Unit independently of capability", async () => {
		const { runtime } = await createRuntime([workUnitStep(), validationStep()]);

		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 2,
			subagentConcurrency: 2,
			workUnitsEnabled: true,
			workUnitModel: "openai/test-work-unit:high",
			adversarialReviewEnabled: true,
			adversarialReviewerModel: "openai/test-reviewer:medium",
			maxRepairAttempts: 1,
		});

		expect(prepared.lanes.map(lane => [lane.workUnitId, lane.modelSelector, lane.reviewRequired])).toEqual([
			["mechanical-unit", "openai/test-work-unit:high", true],
			["reasoning-unit", "openai/test-work-unit:high", true],
		]);
		const mechanical = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(mechanical.id);
		await runtime.settleExecutionLane({ laneId: mechanical.id, exitCode: 0, patchPath: "/tmp/mechanical.patch" });
		expect(runtime.state?.execution.lanes.find(lane => lane.id === mechanical.id)?.status).toBe("awaiting-review");

		const reviewer = await runtime.prepareAdversarialReviewLane(mechanical.id);
		expect(reviewer).toMatchObject({ role: "reviewer", modelSelector: "openai/test-reviewer:medium" });
		await runtime.markExecutionLaneRunning(reviewer.id);
		await runtime.settleExecutionLane({ laneId: reviewer.id, exitCode: 0, outputDigest: "review-pass" });
		await runtime.recordAdversarialReview({
			reviewerLaneId: reviewer.id,
			verdict: "pass",
			findings: [],
			residualRisks: [],
			planImpact: noPlanImpact(),
		});
		expect(runtime.state?.execution.lanes.find(lane => lane.id === mechanical.id)?.status).toBe(
			"awaiting-validation",
		);
		const validators = await runtime.prepareCandidateValidatorLanes(mechanical.id);
		expect(validators.map(lane => lane.validators?.[0])).toEqual(["bun test mechanical"]);
		for (const validator of validators) {
			await runtime.markExecutionLaneRunning(validator.id);
			await runtime.settleExecutionLane({
				laneId: validator.id,
				validator: validator.validators?.[0],
				exitCode: 0,
				outputDigest: "validator-pass",
			});
		}
		await runtime.completeCandidateValidation(mechanical.id);
		expect(runtime.state?.execution.lanes.find(lane => lane.id === mechanical.id)?.status).toBe(
			"awaiting-integration",
		);
	});

	it("skips adversarial review when disabled but preserves candidate validation", async () => {
		const { runtime } = await createRuntime([workUnitStep(), validationStep()]);
		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 2,
			workUnitsEnabled: true,
			adversarialReviewEnabled: false,
		});
		const mechanical = prepared.lanes.find(lane => lane.workUnitId === "mechanical-unit");
		if (!mechanical) throw new Error("missing mechanical Work Unit");

		await runtime.markExecutionLaneRunning(mechanical.id);
		await runtime.settleExecutionLane({ laneId: mechanical.id, exitCode: 0, patchPath: "/tmp/mechanical.patch" });

		expect(runtime.state?.execution.lanes.find(lane => lane.id === mechanical.id)?.status).toBe(
			"awaiting-validation",
		);
		expect(runtime.state?.execution.lanes.some(lane => lane.role === "reviewer")).toBe(false);
	});

	it("supersedes a rejected candidate with a separately selected bounded repair Lane", async () => {
		const { runtime } = await createRuntime([workUnitStep(), validationStep()]);
		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 2,
			workUnitsEnabled: true,
			workUnitModel: "openai/test-work-unit:high",
			adversarialReviewEnabled: true,
			adversarialReviewerModel: "openai/test-reviewer",
			maxRepairAttempts: 1,
		});
		const mechanical = prepared.lanes.find(lane => lane.workUnitId === "mechanical-unit");
		if (!mechanical) throw new Error("missing mechanical Work Unit");
		await runtime.markExecutionLaneRunning(mechanical.id);
		await runtime.settleExecutionLane({ laneId: mechanical.id, exitCode: 0, patchPath: "/tmp/mechanical.patch" });
		const reviewer = await runtime.prepareAdversarialReviewLane(mechanical.id);
		await runtime.markExecutionLaneRunning(reviewer.id);
		await runtime.settleExecutionLane({ laneId: reviewer.id, exitCode: 0, outputDigest: "review-reject" });
		await runtime.recordAdversarialReview({
			reviewerLaneId: reviewer.id,
			verdict: "reject",
			findings: ["Boundary condition is wrong."],
			residualRisks: [],
			planImpact: noPlanImpact(),
		});

		const repair = await runtime.prepareRepairLane(mechanical.id);

		expect(runtime.state?.execution.lanes.find(lane => lane.id === mechanical.id)?.status).toBe("superseded");
		expect(repair).toMatchObject({
			role: "repair",
			parentLaneId: mechanical.id,
			attempt: 1,
			modelSelector: "openai/test-work-unit:high",
		});
	});

	it("keeps execution-only delegated feedback inside a bounded Work Unit repair", async () => {
		const { runtime } = await createRuntime([workUnitStep(), validationStep()]);
		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 2,
			workUnitsEnabled: true,
			adversarialReviewEnabled: false,
			maxRepairAttempts: 1,
		});
		const mechanical = prepared.lanes.find(lane => lane.workUnitId === "mechanical-unit");
		if (!mechanical) throw new Error("missing mechanical Work Unit");
		await runtime.markExecutionLaneRunning(mechanical.id);
		await runtime.settleExecutionLane({
			laneId: mechanical.id,
			exitCode: 0,
			patchPath: "/tmp/mechanical.patch",
			planImpact: {
				level: "execution",
				kind: "implementation-feedback",
				reason: "The local edit needs one bounded correction.",
				evidence: ["The focused check exposed a local type mismatch."],
				affectedStepIds: ["work"],
				contradictedAssumptionIds: [],
				proposedChanges: [],
			},
		});

		expect(runtime.state?.execution.lanes.find(lane => lane.id === mechanical.id)).toMatchObject({
			status: "rejected",
			planImpact: { level: "execution", kind: "implementation-feedback" },
		});
		expect(runtime.state?.stalePlan).toBe(false);
		const repair = await runtime.prepareRepairLane(mechanical.id);
		expect(repair).toMatchObject({ role: "repair", parentLaneId: mechanical.id, planImpact: undefined });
	});

	it("quarantines a structural delegated discovery and opens patch-plan reconciliation", async () => {
		const isolated = workStep({
			execution: {
				executor: "subagent-isolated",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
				isolation: "required",
				integration: "patch",
				failureDomain: "step",
			},
		});
		const { host, runtime } = await createRuntime([isolated, validationStep()]);
		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 1,
			rollingEpoch: true,
			maxRepairAttempts: 1,
		});
		const lane = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(lane.id);
		await runtime.settleExecutionLane({
			laneId: lane.id,
			exitCode: 0,
			patchPath: "/tmp/candidate.patch",
			planImpact: {
				level: "structural",
				kind: "missing-step",
				reason: "A schema registration step must precede this implementation.",
				evidence: ["Entity discovery cannot see the service schema."],
				affectedStepIds: ["work", "verify", "invented-step"],
				contradictedAssumptionIds: ["unknown-assumption"],
				proposedChanges: ["Insert service-schema-registration before work."],
			},
		});

		const settled = runtime.state?.execution.lanes.find(candidate => candidate.id === lane.id);
		expect(settled).toMatchObject({
			status: "awaiting-reconciliation",
			patchPath: "/tmp/candidate.patch",
			planImpact: { level: "structural", kind: "missing-step" },
		});
		expect(runtime.state?.execution.waves.find(wave => wave.id === prepared.wave.id)).toMatchObject({
			status: "reconciling",
			admissionOpen: false,
		});
		expect(runtime.state).toMatchObject({
			phase: "REPLANNING",
			stalePlan: true,
			reconciliation: {
				stepId: "work",
				laneId: lane.id,
				requiredAction: "patch-plan",
				planImpact: { level: "structural" },
			},
		});
		expect(runtime.state?.observations?.find(item => item.id === settled?.planImpactObservationId)).toMatchObject({
			kind: "contradiction",
			affects: [
				{ type: "step", id: "work" },
				{ type: "step", id: "verify" },
			],
		});

		const restarted = new TaskLifecycleRuntime(host);
		expect(restarted.state).toMatchObject({
			phase: "REPLANNING",
			stalePlan: true,
			reconciliation: {
				laneId: lane.id,
				requiredAction: "patch-plan",
				planImpact: { level: "structural", kind: "missing-step" },
			},
		});
		expect(restarted.state?.execution.lanes.find(candidate => candidate.id === lane.id)).toMatchObject({
			status: "awaiting-reconciliation",
			planImpact: { level: "structural", kind: "missing-step" },
		});
	});

	it("separates a passing candidate verdict from a reviewer-detected contract decision", async () => {
		const isolated = workStep({
			execution: {
				executor: "subagent-isolated",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
				isolation: "required",
				integration: "patch",
				failureDomain: "step",
				capability: "mechanical",
			},
		});
		const { runtime } = await createRuntime([isolated, validationStep()]);
		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 1,
			adversarialReviewEnabled: true,
		});
		const candidate = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(candidate.id);
		await runtime.settleExecutionLane({ laneId: candidate.id, exitCode: 0, patchPath: "/tmp/candidate.patch" });
		const reviewer = await runtime.prepareAdversarialReviewLane(candidate.id);
		await runtime.markExecutionLaneRunning(reviewer.id);
		await runtime.settleExecutionLane({ laneId: reviewer.id, exitCode: 0, outputDigest: "reviewed" });
		await runtime.recordAdversarialReview({
			reviewerLaneId: reviewer.id,
			verdict: "pass",
			findings: [],
			residualRisks: [],
			planImpact: {
				level: "contract",
				kind: "scope-change",
				reason: "The candidate is internally correct but requires changing a public API.",
				evidence: ["The approved adapter cannot preserve the public signature."],
				affectedStepIds: ["work"],
				contradictedAssumptionIds: [],
				proposedChanges: ["Ask whether the public API may change."],
			},
		});

		expect(runtime.state?.execution.lanes.find(lane => lane.id === candidate.id)).toMatchObject({
			status: "awaiting-reconciliation",
			reviewVerdict: "pass",
			planImpact: { level: "contract", kind: "scope-change" },
		});
		expect(runtime.state).toMatchObject({
			phase: "AWAITING_USER",
			stalePlan: true,
			reconciliation: { requiredAction: "request-user", planImpact: { level: "contract" } },
		});
	});

	it("keeps a rolling epoch open while admitting a newly ready descendant", async () => {
		const first = validationStep(["printf first"]);
		first.id = "verify-first";
		const second = validationStep(["printf second"]);
		second.id = "verify-second";
		second.dependsOn = ["verify-first"];
		const { runtime } = await createRuntime([workStep(), first, second]);
		await completePrimaryWork(runtime);
		const prepared = await runtime.prepareExecutionWave({
			mode: "validation",
			validationConcurrency: 1,
			subagentConcurrency: 1,
			rollingEpoch: true,
		});
		const firstLane = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(firstLane.id);
		await runtime.settleExecutionLane({
			laneId: firstLane.id,
			validator: firstLane.validators?.[0],
			exitCode: 0,
			outputDigest: "first-pass",
		});
		await runtime.submitVerification({
			stepId: "verify-first",
			evidenceIds: runtime.state?.execution.lanes.find(lane => lane.id === firstLane.id)?.evidenceIds ?? [],
		});

		const admitted = await runtime.admitExecutionWave(prepared.wave.id, {
			mode: "validation",
			validationConcurrency: 1,
			subagentConcurrency: 1,
			rollingEpoch: true,
		});

		expect(admitted.lanes).toHaveLength(1);
		expect(admitted.lanes[0].stepId).toBe("verify-second");
		expect(admitted.wave.id).toBe(prepared.wave.id);
		expect(admitted.wave.admissionCount).toBe(2);
	});

	it("keeps automated Waves behind a ready primary workspace step", async () => {
		const { runtime } = await createRuntime([workStep(), validationStep()]);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getTaskLifecycleRuntime: () => runtime,
			settings: Settings.isolated({ "zzworkflow.execution.mode": "validation" }),
		} as ToolSession;

		const result = await new ZZWorkflowExecuteWaveTool(session).execute("primary-first", {});

		expect(result.details).toMatchObject({ accepted: false, code: "PRIMARY_STEP_READY" });
		expect(summarizeTaskLifecycle(runtime.state)?.requiredNextAction).toBe("execute_active_step");
		expect(runtime.state?.execution.activeWaveId).toBeUndefined();
		expect(
			runtime.prepareExecutionWave({
				mode: "validation",
				validationConcurrency: 1,
				subagentConcurrency: 1,
			}),
		).rejects.toThrow("Primary 단계 work");
	});

	it("reports an execution-mode mismatch instead of retrying a disabled subagent Lane", async () => {
		const readonly = workStep({
			allowedTools: ["read", "grep"],
			execution: {
				executor: "subagent-readonly",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "read" }],
				isolation: "none",
				integration: "none",
				failureDomain: "step",
			},
		});
		const { runtime } = await createRuntime([readonly, validationStep()]);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getTaskLifecycleRuntime: () => runtime,
			settings: Settings.isolated({ "zzworkflow.execution.mode": "validation" }),
		} as ToolSession;

		const result = await new ZZWorkflowExecuteWaveTool(session).execute("disabled-subagent", {});

		expect(result.details).toMatchObject({ accepted: false, executionMode: "validation" });
		expect(runtime.state?.execution.activeWaveId).toBeUndefined();
		expect(summarizeTaskLifecycle(runtime.state)?.requiredNextAction).toBe("enable_safe_parallel_or_patch_executor");
	});

	it("blocks a subagent Wave before journaling when its configured model is not selectable", async () => {
		const readonly = workStep({
			allowedTools: ["read", "grep"],
			execution: {
				executor: "subagent-readonly",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "read" }],
				isolation: "none",
				integration: "none",
				failureDomain: "step",
				capability: "mechanical",
			},
		});
		const { runtime } = await createRuntime([readonly, validationStep()]);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getTaskLifecycleRuntime: () => runtime,
			getActiveModel: () => ({ provider: "openai-codex", id: "gpt-5.6-sol" }),
			modelRegistry: {
				getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
			},
			settings: Settings.isolated({
				"zzworkflow.execution.mode": "safe-parallel",
				"zzworkflow.execution.workUnits.model": "openrouter/z-ai/glm-missing",
			}),
		} as unknown as ToolSession;

		const result = await new ZZWorkflowExecuteWaveTool(session).execute("unavailable-model", {});

		expect(result.details).toMatchObject({ accepted: false, code: "ZZW_MODEL_UNAVAILABLE" });
		expect(result.content.find(item => item.type === "text")?.text).toContain("openrouter/z-ai/glm-missing");
		expect(runtime.state?.execution.activeWaveId).toBeUndefined();
		expect(runtime.state?.pendingOperationIds).toEqual([]);
	});

	it("rejects a writable validator contract that omits snapshot isolation", async () => {
		const invalid = validationStep();
		invalid.execution = {
			executor: "validator",
			resourceClaims: [{ kind: "cache", key: "coverage", access: "write" }],
			isolation: "none",
			integration: "none",
			failureDomain: "step",
		};
		const state = harness();
		const runtime = new TaskLifecycleRuntime(state.host);
		await runtime.handleGoalEvent({ type: "created", goal: goal() });

		expect(runtime.proposePlan({ basedOnSpecVersion: 1, steps: [workStep(), invalid] })).rejects.toThrow(
			"isolation=snapshot",
		);
	});

	it("executes the approved validator Wave and completes the Plan step from fresh evidence", async () => {
		const { runtime } = await createRuntime([
			workStep(),
			validationStep(["printf validator-one", "printf validator-two"]),
		]);
		await completePrimaryWork(runtime);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getTaskLifecycleRuntime: () => runtime,
			settings: Settings.isolated({
				"zzworkflow.execution.mode": "validation",
				"zzworkflow.execution.validationConcurrency": 2,
			}),
		} as ToolSession;

		const result = await new ZZWorkflowExecuteWaveTool(session).execute("wave-call", {});

		expect(runtime.state?.plan.steps.find(step => step.id === "verify")?.status).toBe("completed");
		expect(runtime.state?.execution.waves.at(-1)?.status).toBe("settled");
		expect(runtime.state?.execution.lanes.slice(-2).map(lane => lane.status)).toEqual(["succeeded", "succeeded"]);
		expect(result.content.find(item => item.type === "text")?.text).toContain("validator · succeeded");
	});

	it("discards mutations produced by an isolated validator while retaining its successful evidence", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "zzw-validator-"));
		try {
			await Bun.write(path.join(repo, "tracked.txt"), "baseline\n");
			await $`git init -q`.cwd(repo).quiet();
			await $`git add tracked.txt`.cwd(repo).quiet();
			await $`git -c user.name=ZZ -c user.email=zz@example.invalid commit -qm initial`.cwd(repo).quiet();
			const isolatedValidation = validationStep(["printf generated > validator-output.txt"]);
			isolatedValidation.execution = {
				executor: "validator",
				resourceClaims: [{ kind: "workspace-path", key: "validator-output.txt", access: "write" }],
				isolation: "snapshot",
				integration: "none",
				failureDomain: "step",
			};
			const { runtime } = await createRuntime([workStep(), isolatedValidation], {
				getCwd: () => repo,
				captureWorkspace: () => captureTaskWorkspace(repo, 1),
			});
			await completePrimaryWork(runtime);
			const session = {
				cwd: repo,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getTaskLifecycleRuntime: () => runtime,
				settings: Settings.isolated({
					"zzworkflow.execution.mode": "validation",
				}),
			} as ToolSession;

			await new ZZWorkflowExecuteWaveTool(session).execute("isolated-wave", {});

			expect(await Bun.file(path.join(repo, "validator-output.txt")).exists()).toBe(false);
			expect(runtime.state?.plan.steps.find(step => step.id === "verify")?.status).toBe("completed");
			expect(runtime.state?.evidence.at(-1)?.trust).toBe("verified");
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	it("cancels unstarted siblings after a wave-domain failure while preserving the failed Lane", async () => {
		const waveValidation = validationStep(["exit 7", "printf should-not-run"]);
		waveValidation.execution = {
			executor: "validator",
			resourceClaims: [{ kind: "workspace-path", key: ".", access: "read" }],
			isolation: "none",
			integration: "none",
			failureDomain: "wave",
		};
		const { runtime } = await createRuntime([workStep(), waveValidation]);
		await completePrimaryWork(runtime);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getTaskLifecycleRuntime: () => runtime,
			settings: Settings.isolated({
				"zzworkflow.execution.mode": "validation",
				"zzworkflow.execution.validationConcurrency": 1,
			}),
		} as ToolSession;

		await new ZZWorkflowExecuteWaveTool(session).execute("failed-wave", {});

		expect(runtime.state?.execution.lanes.slice(-2).map(lane => lane.status)).toEqual(["failed", "cancelled"]);
		expect(runtime.state?.execution.waves.at(-1)?.status).toBe("reconciling");
		expect(runtime.state?.reconciliation?.stepId).toBe("verify");
		const failedEvidenceId = runtime.state?.reconciliation?.evidenceIds[0];
		if (!failedEvidenceId) throw new Error("expected failed Wave evidence");
		await runtime.reportStepResult({
			stepId: "verify",
			status: "blocked",
			classification: "missing-precondition",
			evidenceIds: [failedEvidenceId],
			unexpectedEffects: [],
			observedEffects: ["The approved validator requires its local service to be reset"],
		});
		expect(runtime.state?.reconciliation?.requiredAction).toBe("satisfy-approved-precondition");

		const remedy = await runtime.prepareOperation({
			toolCallId: "wave-precondition-remedy",
			toolName: "bash",
			tier: "exec",
			args: { command: "printf reset-service" },
		});
		await runtime.settleOperation("wave-precondition-remedy", false);
		const remedyEvidenceId = runtime.state?.evidence.find(item => item.operationId === remedy?.id)?.id;
		if (!remedyEvidenceId) throw new Error("expected Wave precondition evidence");
		await runtime.reportStepResult({
			stepId: "verify",
			status: "progress",
			classification: "matched",
			evidenceIds: [remedyEvidenceId],
			unexpectedEffects: [],
		});
		expect(runtime.state).toMatchObject({
			phase: "READY",
			plan: { approval: "approved", status: "current" },
			reconciliation: undefined,
		});
		expect(runtime.state?.plan.steps.find(step => step.id === "verify")?.status).toBe("pending");
	});

	it("prepares one validator Lane per command and accepts only their current evidence", async () => {
		const { runtime, entries, syncReasons } = await createRuntime([
			workStep(),
			validationStep(["bun check", "bun test"]),
		]);
		await completePrimaryWork(runtime);

		const prepared = await runtime.prepareExecutionWave({
			mode: "validation",
			validationConcurrency: 4,
			subagentConcurrency: 1,
		});
		expect(prepared.lanes.map(lane => lane.validators?.[0])).toEqual(["bun check", "bun test"]);
		expect(runtime.state?.pendingOperationIds).toHaveLength(2);
		expect(entries.filter(entry => entry.customType === TASK_OPERATION_ENTRY_TYPE).slice(-2)).toHaveLength(2);
		expect(syncReasons.filter(reason => reason === "operation-prepared").slice(-2)).toHaveLength(2);

		for (const lane of prepared.lanes) {
			const operation = runtime.operations.find(candidate => candidate.id === lane.operationIds[0]);
			expect(operation).toMatchObject({ waveId: prepared.wave.id, laneId: lane.id });
			await runtime.markExecutionLaneRunning(lane.id);
			await runtime.settleExecutionLane({
				laneId: lane.id,
				validator: lane.validators?.[0],
				exitCode: 0,
				outputDigest: `digest-${lane.id}`,
			});
		}
		const wave = runtime.state?.execution.waves.find(candidate => candidate.id === prepared.wave.id);
		expect(wave?.status).toBe("settled");
		expect(runtime.state?.pendingOperationIds).toEqual([]);
		const evidenceIds = runtime.state?.execution.lanes
			.filter(lane => lane.waveId === prepared.wave.id)
			.flatMap(lane => lane.evidenceIds);
		await runtime.submitVerification({ stepId: "verify", evidenceIds: evidenceIds ?? [] });
		expect(runtime.state?.plan.steps.find(step => step.id === "verify")?.status).toBe("completed");
	});

	it("quarantines a Lane result that arrives after the approved task contract changed", async () => {
		const { runtime } = await createRuntime([workStep(), validationStep()]);
		await completePrimaryWork(runtime);
		const prepared = await runtime.prepareExecutionWave({
			mode: "validation",
			validationConcurrency: 1,
			subagentConcurrency: 1,
			stepIds: ["verify"],
		});
		const lane = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(lane.id);

		const previousGoal = goal();
		await runtime.handleGoalEvent({
			type: "revised",
			previousGoal,
			goal: { ...previousGoal, objective: `${previousGoal.objective}\n- Preserve public output.`, updatedAt: 2 },
		});
		const settled = await runtime.settleExecutionLane({
			laneId: lane.id,
			validator: "bun check",
			exitCode: 0,
			outputDigest: "passed-against-old-contract",
		});

		expect(settled).toMatchObject({
			status: "awaiting-reconciliation",
			error: "Execution Lane result no longer matches the active ZZWorkflow contract.",
		});
		const evidence = runtime.state?.evidence.find(item => item.id === settled.evidenceIds[0]);
		expect(evidence).toMatchObject({
			stale: true,
			staleReason: "execution-contract-changed",
			trust: "raw",
			specVersion: 1,
			planVersion: prepared.wave.planVersion,
		});
		expect(runtime.state).toMatchObject({
			phase: "REPLANNING",
			stalePlan: true,
			reconciliation: {
				laneId: lane.id,
				classification: "environment-changed",
				requiredAction: "patch-plan",
			},
		});
	});

	it("finalizes a fully recorded successful Wave after restart without rerunning validators", async () => {
		const state = await createRuntime([workStep(), validationStep(["bun check", "bun test"])]);
		await completePrimaryWork(state.runtime);
		const prepared = await state.runtime.prepareExecutionWave({
			mode: "validation",
			validationConcurrency: 2,
			subagentConcurrency: 1,
		});
		for (const lane of prepared.lanes) {
			await state.runtime.markExecutionLaneRunning(lane.id);
			await state.runtime.settleExecutionLane({
				laneId: lane.id,
				validator: lane.validators?.[0],
				exitCode: 0,
				outputDigest: `digest-${lane.id}`,
			});
		}
		expect(state.runtime.state?.plan.steps.find(step => step.id === "verify")?.status).toBe("in_progress");

		const restarted = new TaskLifecycleRuntime(state.host);

		expect(restarted.state?.plan.steps.find(step => step.id === "verify")?.status).toBe("completed");
		expect(restarted.state?.execution.waves.find(wave => wave.id === prepared.wave.id)?.status).toBe("settled");
		expect(restarted.state?.pendingOperationIds).toEqual([]);
	});

	it("journals isolated integration separately and settles the Wave only after integration", async () => {
		const isolated = workStep({
			execution: {
				executor: "subagent-isolated",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
				isolation: "required",
				integration: "patch",
				failureDomain: "step",
			},
		});
		const { runtime } = await createRuntime([isolated, validationStep()]);
		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 1,
		});
		const lane = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(lane.id);
		await runtime.settleExecutionLane({ laneId: lane.id, exitCode: 0, patchPath: "/tmp/lane.patch" });
		expect(runtime.state?.execution.lanes.find(item => item.id === lane.id)?.status).toBe("awaiting-integration");
		expect(runtime.state?.execution.waves.find(item => item.id === prepared.wave.id)?.status).toBe("draining");

		const integration = await runtime.prepareLaneIntegration(lane.id);
		expect(integration).toMatchObject({ toolName: "zzw-integrate", status: "running" });
		expect(runtime.state?.pendingOperationIds).toContain(integration.id);
		await runtime.settleLaneIntegration({ laneId: lane.id, succeeded: true, outputDigest: "applied" });
		expect(runtime.state?.execution.lanes.find(item => item.id === lane.id)?.status).toBe("integrated");
		expect(runtime.state?.execution.waves.find(item => item.id === prepared.wave.id)?.status).toBe("settled");
	});

	it("cancels an isolated result before integration without leaving the Wave draining", async () => {
		const isolated = workStep({
			execution: {
				executor: "subagent-isolated",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
				isolation: "required",
				integration: "patch",
				failureDomain: "step",
			},
		});
		const { runtime } = await createRuntime([isolated, validationStep()]);
		const prepared = await runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 1,
		});
		const lane = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(lane.id);
		await runtime.settleExecutionLane({ laneId: lane.id, exitCode: 0, patchPath: "/tmp/lane.patch" });

		await runtime.cancelLaneBeforeIntegration(lane.id, "cancelled by parent Wave");

		expect(runtime.state?.execution.lanes.find(item => item.id === lane.id)?.status).toBe("cancelled");
		expect(runtime.state?.execution.waves.find(item => item.id === prepared.wave.id)?.status).toBe("interrupted");
		expect(runtime.state?.execution.activeWaveId).toBeUndefined();
		expect(runtime.state?.plan.steps.find(step => step.id === "work")?.status).toBe("pending");
	});

	it("turns an isolated Lane stranded before integration into explicit restart reconciliation", async () => {
		const isolated = workStep({
			execution: {
				executor: "subagent-isolated",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
				isolation: "required",
				integration: "patch",
				failureDomain: "step",
			},
		});
		const state = await createRuntime([isolated, validationStep()]);
		const prepared = await state.runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 1,
		});
		const lane = prepared.lanes[0];
		await state.runtime.markExecutionLaneRunning(lane.id);
		await state.runtime.settleExecutionLane({ laneId: lane.id, exitCode: 0, patchPath: "/tmp/lane.patch" });

		const restarted = new TaskLifecycleRuntime(state.host);

		expect(restarted.state?.execution.lanes.find(candidate => candidate.id === lane.id)?.status).toBe("interrupted");
		expect(restarted.state?.execution.waves.find(wave => wave.id === prepared.wave.id)?.status).toBe("interrupted");
		expect(restarted.state?.execution.activeWaveId).toBeUndefined();
		expect(restarted.state?.phase).toBe("RECONCILING");
		expect(restarted.state?.reconciliation?.stepId).toBe("work");
	});

	it("rehydrates a running Lane as unknown instead of retrying it", async () => {
		const state = await createRuntime([workStep(), validationStep()]);
		await completePrimaryWork(state.runtime);
		const prepared = await state.runtime.prepareExecutionWave({
			mode: "validation",
			validationConcurrency: 1,
			subagentConcurrency: 1,
			stepIds: ["verify"],
		});
		await state.runtime.markExecutionLaneRunning(prepared.lanes[0].id);

		const resumed = new TaskLifecycleRuntime(state.host);
		expect(resumed.state?.phase).toBe("RECOVERING");
		expect(resumed.state?.execution.lanes.find(lane => lane.id === prepared.lanes[0].id)?.status).toBe("unknown");
		expect(resumed.operations.find(operation => operation.id === prepared.lanes[0].operationIds[0])?.status).toBe(
			"unknown",
		);
	});

	it("does not auto-integrate an isolated execution manually reconciled after an unknown restart", async () => {
		const isolated = workStep({
			execution: {
				executor: "subagent-isolated",
				resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
				isolation: "required",
				integration: "patch",
				failureDomain: "step",
			},
		});
		const state = await createRuntime([isolated, validationStep()]);
		const prepared = await state.runtime.prepareExecutionWave({
			mode: "safe-parallel",
			validationConcurrency: 1,
			subagentConcurrency: 1,
		});
		await state.runtime.markExecutionLaneRunning(prepared.lanes[0].id);
		const resumed = new TaskLifecycleRuntime(state.host);
		const operationId = prepared.lanes[0].operationIds[0];

		await resumed.resolveOperation(operationId, "committed");

		expect(resumed.state?.execution.lanes.find(lane => lane.id === prepared.lanes[0].id)?.status).toBe("interrupted");
		expect(resumed.state?.execution.activeWaveId).toBeUndefined();
		expect(resumed.state?.plan.steps.find(step => step.id === "work")?.status).toBe("blocked");
		expect(resumed.state?.reconciliation).toMatchObject({
			stepId: "work",
			classification: "execution-failure",
		});
	});

	it("rejects Plan replacement while a durable Wave still owns operations", async () => {
		const { runtime } = await createRuntime([workStep(), validationStep()]);
		await completePrimaryWork(runtime);
		await runtime.prepareExecutionWave({
			mode: "validation",
			validationConcurrency: 1,
			subagentConcurrency: 1,
		});

		expect(
			runtime.proposePlan({ basedOnSpecVersion: 1, steps: [workStep({ id: "replacement" }), validationStep()] }),
		).rejects.toThrow("Execution Wave");
	});

	it("requires renewed approval when a Plan patch changes the parallel execution contract", async () => {
		const { runtime } = await createRuntime([workStep(), validationStep()]);
		const currentPlanVersion = runtime.state?.planVersion;
		if (currentPlanVersion === undefined) throw new Error("missing current Plan version");

		const plan = await runtime.patchPlan({
			basedOnPlanVersion: currentPlanVersion,
			addSteps: [],
			updateSteps: [
				{
					id: "work",
					execution: {
						executor: "subagent-isolated",
						resourceClaims: [{ kind: "workspace-path", key: "src", access: "write" }],
						isolation: "required",
						integration: "patch",
						failureDomain: "step",
					},
				},
			],
			removeStepIds: [],
			preserveStepIds: [],
			contradictedAssumptions: [],
			failedStepIds: [],
			rationale: "Run the already-approved work in isolation.",
		});

		expect(plan.approvalImpact).toBe("material");
		expect(plan.approval).toBe("draft");
	});

	it("returns a cancelled safe validator step to pending without inventing a failure reconciliation", async () => {
		const { runtime } = await createRuntime([workStep(), validationStep()]);
		await completePrimaryWork(runtime);
		const prepared = await runtime.prepareExecutionWave({
			mode: "validation",
			validationConcurrency: 1,
			subagentConcurrency: 1,
		});
		const lane = prepared.lanes[0];
		await runtime.markExecutionLaneRunning(lane.id);
		await runtime.settleExecutionLane({
			laneId: lane.id,
			validator: lane.validators?.[0],
			outputDigest: "cancelled",
			cancelled: true,
			interrupted: true,
		});

		expect(runtime.state?.execution.waves.find(wave => wave.id === prepared.wave.id)?.status).toBe("interrupted");
		expect(runtime.state?.plan.steps.find(step => step.id === "verify")?.status).toBe("pending");
		expect(runtime.state?.phase).toBe("READY");
		expect(runtime.state?.reconciliation).toBeUndefined();
	});
});
