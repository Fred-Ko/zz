import { describe, expect, it } from "bun:test";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	projectTaskPlanPhases,
	TASK_LIFECYCLE_ENTRY_TYPE,
	TASK_LIFECYCLE_SCHEMA_VERSION,
	type TaskLifecycleHost,
	type TaskLifecycleJournalEntry,
	TaskLifecycleRuntime,
	type TaskLifecycleState,
	type TaskPlan,
	TaskPlanValidationError,
	type TaskWorkspaceSnapshot,
} from "@oh-my-pi/pi-coding-agent/goals/task-lifecycle";

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "task-1",
		objective: [
			"## Objective",
			"Ship lifecycle recovery.",
			"## Success criteria",
			"- A prepared write survives restart.",
			"## Verification",
			"- bun test task-lifecycle.test.ts",
			"## Boundaries",
			"- packages/coding-agent",
			"## Stop conditions",
			"- Stop on an ambiguous prepared operation.",
		].join("\n"),
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	};
}

function createWorkspace(overrides: Partial<TaskWorkspaceSnapshot> = {}): TaskWorkspaceSnapshot {
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
		capturedAt: 100,
		...overrides,
	};
}

function createHarness(
	workspaces: TaskWorkspaceSnapshot[] = [createWorkspace()],
	planPatchApprovalMode: "always" | "material" = "material",
) {
	const entries: TaskLifecycleJournalEntry[] = [];
	const events: string[] = [];
	const knowledgeReviews: TaskLifecycleState[] = [];
	const sharedReasons: string[] = [];
	const recallStages: string[] = [];
	let now = 100;
	let sessionId = "session-1";
	let id = 0;
	let captureIndex = 0;
	const host: TaskLifecycleHost = {
		getSessionId: () => sessionId,
		getCwd: () => "/repo",
		getEntries: () => entries,
		appendCustomEntry: (customType, data) => {
			events.push(`append:${customType}`);
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		ensureOnDisk: async () => {
			events.push("ensure");
		},
		flush: async () => {
			events.push("flush");
		},
		captureWorkspace: async () => {
			const workspace = workspaces[Math.min(captureIndex, workspaces.length - 1)];
			captureIndex++;
			if (!workspace) throw new Error("workspace fixture missing");
			return { ...workspace, capturedAt: now };
		},
		requestTaskKnowledgeReview: state => {
			knowledgeReviews.push(state);
		},
		syncZZWorkflowState: async (_state, reason) => {
			sharedReasons.push(reason);
		},
		recallTaskKnowledge: async (_state, stage) => {
			recallStages.push(stage);
			return '<knowledge-working-set authoritative="false">advisory</knowledge-working-set>';
		},
		planPatchApprovalMode: () => planPatchApprovalMode,
		now: () => now,
		mintId: kind => `${kind}-${++id}`,
	};
	return {
		host,
		entries,
		events,
		knowledgeReviews,
		sharedReasons,
		recallStages,
		setSessionId: (value: string) => {
			sessionId = value;
		},
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
	};
}

async function activatePlan(
	runtime: TaskLifecycleRuntime,
	validator = "bun test task-lifecycle.test.ts",
): Promise<void> {
	const specification = runtime.state?.specification;
	const successConditionIds = specification?.successCriteria?.map(criterion => criterion.id) ?? [];
	const verificationIds = specification?.verificationExplicit
		? (specification.verificationRequirements?.map(requirement => requirement.id) ?? [])
		: [];
	await runtime.proposePlan({
		basedOnSpecVersion: runtime.state?.specVersion ?? 1,
		steps: [
			{
				id: "work-1",
				phase: "Implementation",
				content: "Implement lifecycle recovery",
				kind: "work",
				dependsOn: [],
				expectedEffects: ["Lifecycle behavior changes"],
				allowedTools: ["write", "bash"],
				allowedTargets: [],
				postconditions: ["Implementation evidence exists"],
				successConditionIds: [],
				verificationIds: [],
				validators: [],
				rerunPolicy: "safe",
				riskClass: "low",
			},
			{
				id: "verify-1",
				phase: "Validation",
				content: validator,
				kind: "validation",
				dependsOn: ["work-1"],
				expectedEffects: [],
				allowedTools: ["bash"],
				allowedTargets: [],
				postconditions: ["Validator passes"],
				successConditionIds,
				verificationIds,
				validators: [validator],
				rerunPolicy: "safe",
				riskClass: "low",
			},
		],
	});
	await runtime.approvePlan();
}

describe("task lifecycle", () => {
	it("creates no durable task for conversation until a goal is explicitly committed", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);

		expect(runtime.state).toBeUndefined();
		expect(harness.entries).toHaveLength(0);

		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });

		const state = runtime.state;
		expect(state).toMatchObject({
			taskId: "task-1",
			specVersion: 1,
			planVersion: 1,
			phase: "AWAITING_USER",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			readiness: { ready: false, blockers: [{ code: "PLAN_NOT_APPROVED" }] },
		});
		expect(state?.specification.successConditions).toEqual(["A prepared write survives restart."]);
		expect(state?.specification.successCriteria).toEqual([
			{ id: "SC-1", description: "A prepared write survives restart." },
		]);
		expect(state?.specification.verification).toEqual(["bun test task-lifecycle.test.ts"]);
		expect(state?.specification.verificationRequirements).toEqual([
			{ id: "V-1", description: "bun test task-lifecycle.test.ts" },
		]);
		expect(state?.plan.steps[0]).toMatchObject({
			phase: "Acceptance",
			content: "A prepared write survives restart.",
			status: "pending",
		});
		expect(state?.plan.steps[1]).toMatchObject({
			phase: "Verification",
			content: "bun test task-lifecycle.test.ts",
			kind: "validation",
		});
		expect(harness.sharedReasons).toContain("created");
		expect(harness.recallStages).toEqual(["intake"]);
		expect(runtime.buildContext()).toContain('<zzworkflow authoritative="true"');
		expect(runtime.buildContext()).toContain("Required next action: propose_executable_plan");
		expect(runtime.buildContext()).toContain('authoritative="false"');
	});

	it("maps verification prose to an executable validator through stable IDs in one proposal", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({
			type: "created",
			goal: createGoal({
				objective: [
					"## Objective",
					"Migrate persistence.",
					"## Success criteria",
					"- All persistence uses MikroORM.",
					"## Verification",
					"- 저장소 루트에서 `yarn verify`를 실행하고 종료 코드 0을 확인한다.",
				].join("\n"),
			}),
		});

		const plan = await runtime.proposePlan({
			basedOnSpecVersion: 1,
			steps: [
				{
					id: "migrate",
					phase: "Implementation",
					content: "Migrate persistence",
					kind: "work",
					dependsOn: [],
					expectedEffects: ["Persistence changes"],
					allowedTools: ["write", "bash"],
					allowedTargets: [],
					postconditions: ["Migration is implemented"],
					successConditionIds: [],
					verificationIds: [],
					validators: [],
					rerunPolicy: "guarded",
					riskClass: "high",
				},
				{
					id: "verify",
					phase: "Validation",
					content: "Run the repository verification suite",
					kind: "validation",
					dependsOn: ["migrate"],
					expectedEffects: [],
					allowedTools: ["bash"],
					allowedTargets: [],
					postconditions: ["Verification passes"],
					successConditionIds: ["SC-1"],
					verificationIds: ["V-1"],
					validators: ["yarn verify"],
					rerunPolicy: "safe",
					riskClass: "low",
				},
			],
		});

		expect(plan).toMatchObject({
			version: 2,
			approval: "draft",
			steps: [
				{ id: "migrate" },
				{
					id: "verify",
					successConditionIds: ["SC-1"],
					verificationIds: ["V-1"],
					validators: ["yarn verify"],
				},
			],
		});
	});

	it("returns all missing specification mappings in one validation error", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });

		let caught: unknown;
		try {
			await runtime.proposePlan({
				basedOnSpecVersion: 1,
				steps: [
					{
						id: "work",
						phase: "Implementation",
						content: "Implement",
						kind: "work",
						dependsOn: [],
						expectedEffects: [],
						allowedTools: ["write"],
						allowedTargets: [],
						postconditions: [],
						successConditionIds: [],
						verificationIds: [],
						validators: [],
						rerunPolicy: "safe",
						riskClass: "low",
					},
					{
						id: "verify",
						phase: "Validation",
						content: "Verify",
						kind: "validation",
						dependsOn: ["work"],
						expectedEffects: [],
						allowedTools: ["bash"],
						allowedTargets: [],
						postconditions: [],
						successConditionIds: [],
						verificationIds: [],
						validators: ["bun check"],
						rerunPolicy: "safe",
						riskClass: "low",
					},
				],
			});
		} catch (error) {
			caught = error;
		}

		if (!(caught instanceof TaskPlanValidationError)) throw caught;
		expect(caught.issues.map(issue => issue.code)).toEqual(["UNMAPPED_SUCCESS_CONDITION", "UNMAPPED_VERIFICATION"]);
		expect(runtime.state?.planVersion).toBe(1);
	});

	it("uses an approved dependency-aware Plan DAG and attaches mutations to its active step", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });

		await activatePlan(runtime);

		expect(runtime.state).toMatchObject({
			planVersion: 2,
			stalePlan: false,
			plan: {
				version: 2,
				status: "current",
				approval: "approved",
			},
		});
		expect(runtime.state?.plan.steps[0]).toMatchObject({ id: "work-1", dependsOn: [] });
		expect(runtime.state?.plan.steps[1]).toMatchObject({ id: "verify-1", dependsOn: ["work-1"] });
		const operation = await runtime.prepareOperation({
			toolCallId: "call-plan",
			toolName: "write",
			tier: "write",
			args: { path: "src/lifecycle.ts" },
		});
		expect(operation?.planStepId).toBe("work-1");
	});

	it("reconciles a failed operation and carries approval through a structural repair", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		await runtime.prepareOperation({
			toolCallId: "failed-write",
			toolName: "write",
			tier: "write",
			args: { path: "src/lifecycle.ts" },
		});
		await runtime.settleOperation("failed-write", true);
		const failedEvidenceId = runtime.state?.evidence.at(-1)?.id;
		if (!failedEvidenceId) throw new Error("expected failed operation evidence");

		expect(runtime.state).toMatchObject({
			phase: "RECONCILING",
			stalePlan: false,
			plan: { approval: "approved", status: "current" },
			reconciliation: { stepId: "work-1", repeatedFailures: 1, requiredAction: "classify-result" },
		});
		expect(runtime.state?.plan.steps.map(step => [step.id, step.status])).toEqual([
			["work-1", "blocked"],
			["verify-1", "pending"],
		]);
		await expect(runtime.approvePlan()).rejects.toThrow("active reconciliation must be classified");
		await runtime.reportStepResult({
			stepId: "work-1",
			status: "failed",
			classification: "contradicted-assumption",
			evidenceIds: [failedEvidenceId],
			unexpectedEffects: [],
			contradictedAssumptionIds: ["A-1"],
		});
		expect(runtime.state).toMatchObject({
			phase: "REPLANNING",
			stalePlan: true,
			plan: { approval: "approved", status: "stale" },
		});
		await runtime.patchPlan({
			basedOnPlanVersion: 2,
			addSteps: [
				{
					id: "diagnose-1",
					phase: "Repair",
					content: "Correct the contradicted write precondition",
					kind: "work",
					dependsOn: [],
					expectedEffects: ["The write precondition is established"],
					allowedTools: ["bash"],
					allowedTargets: [],
					postconditions: ["The failed condition has changed"],
					successConditionIds: [],
					verificationIds: [],
					validators: [],
					rerunPolicy: "safe",
					riskClass: "low",
				},
			],
			updateSteps: [{ id: "work-1", dependsOn: ["diagnose-1"], assumptionIds: ["A-1"] }],
			removeStepIds: [],
			preserveStepIds: [],
			contradictedAssumptions: ["A-1"],
			failedStepIds: ["work-1"],
			rationale: "Retry after correcting the failed condition",
		});
		expect(runtime.state?.plan.steps.map(step => step.status)).toEqual(["pending", "pending", "pending"]);
		expect(runtime.state).toMatchObject({
			phase: "READY",
			stalePlan: false,
			plan: { approval: "approved", approvalImpact: "structural" },
		});
		expect(runtime.state?.plan.changes?.at(-1)).toMatchObject({
			kind: "repair",
			failedStepIds: ["work-1"],
			approvalImpact: "structural",
		});
	});

	it("preserves omitted fields in a partial Plan patch", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		await runtime.patchPlan({
			basedOnPlanVersion: 2,
			addSteps: [],
			updateSteps: [
				{
					id: "work-1",
					content: "Implement lifecycle recovery safely",
					phase: undefined,
					kind: undefined,
					dependsOn: undefined,
					expectedEffects: undefined,
					allowedTools: undefined,
					allowedTargets: ["src/**"],
					postconditions: undefined,
					successConditionIds: undefined,
					verificationIds: undefined,
					validators: undefined,
					rerunPolicy: undefined,
					riskClass: undefined,
				},
			],
			removeStepIds: [],
			preserveStepIds: [],
			contradictedAssumptions: [],
			failedStepIds: [],
			rationale: "Narrow the write target without replacing the step contract",
		});

		expect(runtime.state?.plan.steps[0]).toMatchObject({
			id: "work-1",
			phase: "Implementation",
			content: "Implement lifecycle recovery safely",
			kind: "work",
			status: "pending",
			dependsOn: [],
			expectedEffects: ["Lifecycle behavior changes"],
			allowedTools: ["write", "bash"],
			allowedTargets: ["src/**"],
			postconditions: ["Implementation evidence exists"],
			successConditionIds: [],
			verificationIds: [],
			successConditions: [],
			validators: [],
			rerunPolicy: "safe",
			riskClass: "low",
			originPlanVersion: 2,
			lastChangedPlanVersion: 3,
		});
		expect(runtime.state).toMatchObject({ phase: "READY", plan: { approval: "approved" } });
	});

	it("requires fresh approval when a Plan patch expands tool authority", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		await runtime.patchPlan({
			basedOnPlanVersion: 2,
			addSteps: [],
			updateSteps: [{ id: "work-1", allowedTools: ["write", "bash", "github"] }],
			removeStepIds: [],
			preserveStepIds: [],
			contradictedAssumptions: [],
			failedStepIds: [],
			rationale: "The implementation now needs external repository mutation authority",
		});

		expect(runtime.state).toMatchObject({
			phase: "AWAITING_USER",
			plan: { approval: "draft", approvalImpact: "material" },
		});
	});

	it("requires fresh approval when a new root step expands the approved execution scope", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		await runtime.patchPlan({
			basedOnPlanVersion: 2,
			addSteps: [
				{
					id: "publish-1",
					phase: "Delivery",
					content: "Publish the implementation to an external repository",
					kind: "work",
					dependsOn: ["work-1"],
					expectedEffects: ["An external repository changes"],
					allowedTools: ["github"],
					allowedTargets: [],
					postconditions: ["The external repository contains the implementation"],
					successConditionIds: [],
					verificationIds: [],
					validators: [],
					rerunPolicy: "guarded",
					riskClass: "medium",
				},
			],
			updateSteps: [],
			removeStepIds: [],
			preserveStepIds: [],
			contradictedAssumptions: [],
			failedStepIds: [],
			rationale: "The delivery scope expanded beyond the approved implementation Plan",
		});

		expect(runtime.state).toMatchObject({
			phase: "AWAITING_USER",
			plan: { approval: "draft", approvalImpact: "material" },
		});
	});

	it("requires approval for every Plan patch when configured in always mode", async () => {
		const harness = createHarness([createWorkspace()], "always");
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		await runtime.patchPlan({
			basedOnPlanVersion: 2,
			addSteps: [],
			updateSteps: [{ id: "work-1", content: "Implement lifecycle recovery with focused checks" }],
			removeStepIds: [],
			preserveStepIds: [],
			contradictedAssumptions: [],
			failedStepIds: [],
			rationale: "Clarify the existing approved implementation step",
		});

		expect(runtime.state).toMatchObject({
			phase: "AWAITING_USER",
			plan: { approval: "draft", approvalImpact: "structural" },
		});
	});

	it("continues routine implementation feedback in the same approved step without patching the Plan", async () => {
		const base = createWorkspace();
		const fixed = createWorkspace({ dirtyTreeHash: "code-fixed" });
		const harness = createHarness([base, base, base, base, base, fixed, fixed]);
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		const failedCheck = await runtime.prepareOperation({
			toolCallId: "check-before-fix",
			toolName: "bash",
			tier: "exec",
			args: { command: "yarn test" },
		});
		await runtime.settleOperation("check-before-fix", true);
		const failedEvidenceId = runtime.state?.evidence.find(item => item.operationId === failedCheck?.id)?.id;
		if (!failedEvidenceId) throw new Error("expected failed check evidence");

		await runtime.reportStepResult({
			stepId: "work-1",
			status: "progress",
			classification: "implementation-feedback",
			evidenceIds: [failedEvidenceId],
			unexpectedEffects: [],
			observedEffects: ["The check identified a correctable code defect inside the active step"],
		});

		expect(runtime.state).toMatchObject({
			phase: "EXECUTING",
			planVersion: 2,
			stalePlan: false,
			plan: { approval: "approved", status: "current", version: 2 },
			reconciliation: undefined,
		});
		expect(runtime.state?.plan.steps.find(step => step.id === "work-1")?.status).toBe("in_progress");

		await runtime.prepareOperation({
			toolCallId: "apply-fix",
			toolName: "write",
			tier: "write",
			args: { path: "src/lifecycle.ts" },
		});
		await runtime.settleOperation("apply-fix", false);
		const retry = await runtime.prepareOperation({
			toolCallId: "check-after-fix",
			toolName: "bash",
			tier: "exec",
			args: { command: "yarn test" },
		});

		expect(retry?.fingerprint).not.toBe(failedCheck?.fingerprint);
		expect(runtime.state?.planVersion).toBe(2);
	});

	it("prepares an approved missing service prerequisite without creating a new Plan version", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		const failedInfra = await runtime.prepareOperation({
			toolCallId: "infra-before-daemon",
			toolName: "bash",
			tier: "exec",
			args: { command: "yarn infra:test" },
		});
		await runtime.settleOperation("infra-before-daemon", true);
		const failedEvidenceId = runtime.state?.evidence.find(item => item.operationId === failedInfra?.id)?.id;
		if (!failedEvidenceId) throw new Error("expected missing prerequisite evidence");

		await runtime.reportStepResult({
			stepId: "work-1",
			status: "progress",
			classification: "missing-precondition",
			evidenceIds: [failedEvidenceId],
			unexpectedEffects: [],
			observedEffects: ["The approved integration check requires the local container daemon"],
		});
		await runtime.prepareOperation({
			toolCallId: "start-daemon",
			toolName: "bash",
			tier: "exec",
			args: { command: "systemctl --user start docker-desktop.service" },
		});
		await runtime.settleOperation("start-daemon", false);

		expect(runtime.state).toMatchObject({
			planVersion: 2,
			stalePlan: false,
			plan: { approval: "approved", status: "current", version: 2 },
			reconciliation: undefined,
		});
	});

	it("rejects Plan patch churn while a first execution failure only needs a changed retry condition", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		const operation = await runtime.prepareOperation({
			toolCallId: "transient-failure",
			toolName: "bash",
			tier: "exec",
			args: { command: "yarn test" },
		});
		await runtime.settleOperation("transient-failure", true);
		const evidenceId = runtime.state?.evidence.find(item => item.operationId === operation?.id)?.id;
		if (!evidenceId) throw new Error("expected execution failure evidence");

		await runtime.reportStepResult({
			stepId: "work-1",
			status: "blocked",
			classification: "execution-failure",
			evidenceIds: [evidenceId],
			unexpectedEffects: [],
		});

		expect(runtime.state).toMatchObject({
			phase: "RECONCILING",
			planVersion: 2,
			stalePlan: false,
			plan: { approval: "approved", status: "current" },
			reconciliation: { requiredAction: "retry-with-changed-condition" },
		});
		await expect(
			runtime.patchPlan({
				basedOnPlanVersion: 2,
				addSteps: [],
				updateSteps: [{ id: "work-1", content: "Retry the same approved implementation step" }],
				removeStepIds: [],
				preserveStepIds: [],
				contradictedAssumptions: [],
				failedStepIds: ["work-1"],
				rationale: "Rewrite the Plan instead of changing the execution condition",
			}),
		).rejects.toThrow("PLAN_PATCH_NOT_REQUIRED");
		expect(runtime.state?.planVersion).toBe(2);
	});

	it("expands a rolling milestone while preserving unaffected completed evidence and lineage", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await runtime.proposePlan({
			basedOnSpecVersion: 1,
			steps: [
				{
					id: "survey",
					phase: "Discovery",
					content: "Survey the persistence boundary",
					kind: "work",
					dependsOn: [],
					expectedEffects: ["A persistence inventory exists"],
					allowedTools: ["bash"],
					allowedTargets: [],
					postconditions: ["The implementation horizon can be planned"],
					successConditionIds: [],
					verificationIds: [],
					validators: [],
					rerunPolicy: "safe",
					riskClass: "low",
					producesArtifacts: ["persistence-inventory"],
				},
				{
					id: "implementation-horizon",
					phase: "Planning",
					content: "Expand the implementation from the persistence inventory",
					kind: "milestone",
					dependsOn: ["survey"],
					expectedEffects: [],
					allowedTools: ["write", "bash"],
					allowedTargets: [],
					postconditions: [],
					successConditionIds: [],
					verificationIds: [],
					validators: [],
					rerunPolicy: "never",
					riskClass: "low",
					consumesArtifacts: ["persistence-inventory"],
				},
				{
					id: "verify",
					phase: "Validation",
					content: "Run lifecycle verification",
					kind: "validation",
					dependsOn: ["implementation-horizon"],
					expectedEffects: [],
					allowedTools: ["bash"],
					allowedTargets: [],
					postconditions: ["Verification passes"],
					successConditionIds: ["SC-1"],
					verificationIds: ["V-1"],
					validators: ["bun test task-lifecycle.test.ts"],
					rerunPolicy: "safe",
					riskClass: "low",
				},
			],
		});
		await runtime.approvePlan();
		const operation = await runtime.prepareOperation({
			toolCallId: "survey-call",
			toolName: "bash",
			tier: "exec",
			args: { command: "inspect persistence" },
		});
		await runtime.settleOperation("survey-call", false);
		const evidenceId = runtime.state?.evidence.find(item => item.operationId === operation?.id)?.id;
		if (!evidenceId) throw new Error("expected survey evidence");
		await runtime.reportStepResult({
			stepId: "survey",
			status: "completed",
			classification: "matched",
			evidenceIds: [evidenceId],
			unexpectedEffects: [],
		});

		await runtime.patchPlan({
			basedOnPlanVersion: 2,
			addSteps: [
				{
					id: "implement",
					phase: "Implementation",
					content: "Implement the surveyed persistence conversion",
					kind: "work",
					dependsOn: ["survey"],
					expectedEffects: ["Persistence conversion is implemented"],
					allowedTools: ["write", "bash"],
					allowedTargets: [],
					postconditions: ["The converted implementation is ready for verification"],
					successConditionIds: [],
					verificationIds: [],
					validators: [],
					rerunPolicy: "safe",
					riskClass: "low",
					supersedes: ["implementation-horizon"],
					consumesArtifacts: ["persistence-inventory"],
				},
			],
			updateSteps: [{ id: "verify", dependsOn: ["implement"] }],
			removeStepIds: ["implementation-horizon"],
			preserveStepIds: ["survey"],
			contradictedAssumptions: [],
			failedStepIds: [],
			changeKind: "expansion",
			rationale: "The survey made the next implementation wave concrete",
		});

		expect(runtime.state).toMatchObject({ phase: "READY", plan: { approval: "approved", version: 3 } });
		expect(runtime.state?.plan.steps.map(step => [step.id, step.status])).toEqual([
			["survey", "completed"],
			["implementation-horizon", "superseded"],
			["verify", "pending"],
			["implement", "pending"],
		]);
		expect(runtime.state?.evidence.find(item => item.id === evidenceId)).toMatchObject({ stale: false });
		expect(runtime.state?.plan.changes?.at(-1)).toMatchObject({
			kind: "expansion",
			supersededStepIds: ["implementation-horizon"],
			preservedStepIds: ["survey"],
		});

		await runtime.patchPlan({
			basedOnPlanVersion: 3,
			addSteps: [
				{
					id: "publish",
					phase: "Delivery",
					content: "Publish the converted implementation",
					kind: "work",
					dependsOn: ["implement"],
					expectedEffects: ["An external repository changes"],
					allowedTools: ["github"],
					allowedTargets: [],
					postconditions: ["The external repository contains the conversion"],
					successConditionIds: [],
					verificationIds: [],
					validators: [],
					rerunPolicy: "guarded",
					riskClass: "medium",
					parentStepId: "implement",
				},
			],
			updateSteps: [],
			removeStepIds: [],
			preserveStepIds: ["survey"],
			contradictedAssumptions: [],
			failedStepIds: [],
			changeKind: "expansion",
			rationale: "Expand beyond the implementation branch's approved tool and risk envelope",
		});

		expect(runtime.state).toMatchObject({
			phase: "AWAITING_USER",
			plan: { approval: "draft", approvalImpact: "material", version: 4 },
		});
	});

	it("stops an unchanged operation fingerprint after a repeated failure", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		await runtime.prepareOperation({
			toolCallId: "attempt-1",
			toolName: "write",
			tier: "write",
			args: { path: "src/lifecycle.ts" },
		});
		await runtime.settleOperation("attempt-1", true);
		const firstEvidence = runtime.state?.evidence.at(-1)?.id;
		if (!firstEvidence) throw new Error("expected first failure evidence");
		await runtime.reportStepResult({
			stepId: "work-1",
			status: "failed",
			classification: "execution-failure",
			evidenceIds: [firstEvidence],
			unexpectedEffects: [],
			changedCondition: "The missing temporary directory was created",
		});
		expect(runtime.state).toMatchObject({ phase: "READY", reconciliation: undefined });

		await runtime.prepareOperation({
			toolCallId: "attempt-2",
			toolName: "write",
			tier: "write",
			args: { path: "src/lifecycle.ts" },
		});
		await runtime.settleOperation("attempt-2", true);
		const secondEvidence = runtime.state?.evidence.at(-1)?.id;
		if (!secondEvidence) throw new Error("expected second failure evidence");
		expect(runtime.state?.reconciliation).toMatchObject({ repeatedFailures: 2, requiredAction: "patch-plan" });
		await runtime.reportStepResult({
			stepId: "work-1",
			status: "failed",
			classification: "execution-failure",
			evidenceIds: [secondEvidence],
			unexpectedEffects: [],
			changedCondition: "Retry requested without a new operation fingerprint",
		});
		expect(runtime.state).toMatchObject({ phase: "REPLANNING", stalePlan: true });
	});

	it("migrates schema v1 snapshots into the evolving Plan state model", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);
		const persisted = runtime.state;
		if (!persisted) throw new Error("expected persisted state");
		const legacyState = structuredClone(persisted) as unknown as Record<string, unknown>;
		legacyState.schemaVersion = 1;
		const legacyPlan = legacyState.plan;
		if (
			!legacyPlan ||
			typeof legacyPlan !== "object" ||
			!("steps" in legacyPlan) ||
			!Array.isArray(legacyPlan.steps)
		) {
			throw new Error("expected legacy Plan fixture");
		}
		Reflect.deleteProperty(legacyPlan, "changes");
		Reflect.deleteProperty(legacyPlan, "basedOnVersion");
		for (const rawStep of legacyPlan.steps) {
			if (!rawStep || typeof rawStep !== "object") continue;
			for (const field of [
				"originPlanVersion",
				"lastChangedPlanVersion",
				"contractHash",
				"supersedes",
				"supersededBy",
				"assumptionIds",
				"consumesArtifacts",
				"producesArtifacts",
			]) {
				Reflect.deleteProperty(rawStep, field);
			}
		}
		harness.entries.push({
			type: "custom",
			customType: TASK_LIFECYCLE_ENTRY_TYPE,
			data: { schemaVersion: 1, kind: "snapshot", state: legacyState },
		});

		const restarted = new TaskLifecycleRuntime(harness.host);
		expect(restarted.state).toMatchObject({ schemaVersion: TASK_LIFECYCLE_SCHEMA_VERSION, planVersion: 2 });
		expect(restarted.state?.plan.steps[0]).toMatchObject({
			originPlanVersion: 1,
			lastChangedPlanVersion: 2,
			assumptionIds: [],
		});
	});

	it("projects a recoverable Todo label instead of rendering undefined Plan text", () => {
		const corruptedPlan = {
			version: 3,
			status: "current",
			approval: "approved",
			steps: [{ id: "runtime-config", status: "pending", dependsOn: [] }],
		} as unknown as TaskPlan;

		expect(projectTaskPlanPhases(corruptedPlan)).toEqual([
			{
				name: "복구 필요",
				tasks: [{ content: "runtime-config · 손상된 Plan 단계", status: "pending" }],
			},
		]);
	});

	it("rejects an empty required display field before a patched Plan can be approved", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		let caught: unknown;
		try {
			await runtime.patchPlan({
				basedOnPlanVersion: 2,
				addSteps: [],
				updateSteps: [{ id: "work-1", phase: "" }],
				removeStepIds: [],
				preserveStepIds: [],
				contradictedAssumptions: [],
				failedStepIds: [],
				rationale: "Exercise malformed Plan validation",
			});
		} catch (error) {
			caught = error;
		}

		if (!(caught instanceof TaskPlanValidationError)) throw caught;
		expect(caught.issues).toContainEqual({
			code: "STEP_PHASE_MISSING",
			message: "work-1 단계의 phase가 비어 있습니다.",
			stepId: "work-1",
		});
		expect(runtime.state?.planVersion).toBe(2);
		expect(runtime.state?.plan.approval).toBe("approved");
	});

	it("repairs snapshots written by the legacy partial-patch field erasure bug", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);
		const corrupted = runtime.state;
		if (!corrupted) throw new Error("expected lifecycle state");
		corrupted.planVersion = 3;
		corrupted.plan.version = 3;
		corrupted.plan.approval = "approved";
		const workStep = corrupted.plan.steps[0];
		if (!workStep) throw new Error("expected work step");
		workStep.content = "Implement lifecycle recovery with the adjusted boundary";
		Reflect.deleteProperty(workStep, "phase");
		Reflect.deleteProperty(workStep, "kind");
		Reflect.deleteProperty(workStep, "rerunPolicy");
		Reflect.deleteProperty(workStep, "riskClass");
		workStep.dependsOn = [];
		workStep.expectedEffects = [];
		workStep.allowedTools = [];
		workStep.postconditions = [];
		harness.entries.push({
			type: "custom",
			customType: TASK_LIFECYCLE_ENTRY_TYPE,
			data: { schemaVersion: TASK_LIFECYCLE_SCHEMA_VERSION, kind: "snapshot", state: corrupted },
		});

		const restarted = new TaskLifecycleRuntime(harness.host);

		expect(restarted.state?.planVersion).toBe(3);
		expect(restarted.state?.plan.steps[0]).toMatchObject({
			id: "work-1",
			phase: "Implementation",
			content: "Implement lifecycle recovery with the adjusted boundary",
			kind: "work",
			expectedEffects: ["Lifecycle behavior changes"],
			allowedTools: ["write", "bash"],
			postconditions: ["Implementation evidence exists"],
			rerunPolicy: "safe",
			riskClass: "low",
		});
	});

	it("rejects a command that is not the active validation step's exact validator", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);
		const operation = await runtime.prepareOperation({
			toolCallId: "work",
			toolName: "write",
			tier: "write",
			args: { path: "src/lifecycle.ts" },
		});
		await runtime.settleOperation("work", false);
		const evidenceId = runtime.state?.evidence.find(item => item.operationId === operation?.id)?.id;
		if (!evidenceId) throw new Error("expected work evidence");
		await runtime.reportStepResult({
			stepId: "work-1",
			status: "completed",
			evidenceIds: [evidenceId],
			unexpectedEffects: [],
		});

		await expect(
			runtime.prepareOperation({
				toolCallId: "wrong-validator",
				toolName: "bash",
				tier: "exec",
				args: { command: "bun test something-else.test.ts" },
			}),
		).rejects.toThrow("only permits an exact declared validator command");
	});

	it("blocks an unstructured task until the persisted plan defines validation", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({
			type: "created",
			goal: createGoal({ objective: "Fix lifecycle recovery." }),
		});

		expect(runtime.state?.readiness).toMatchObject({ ready: false, successMeasurable: false });
		expect(runtime.state?.readiness.blockers.map(blocker => blocker.code)).toEqual([
			"SUCCESS_NOT_MEASURABLE",
			"PLAN_NOT_APPROVED",
		]);
		expect(runtime.state?.phase).toBe("AWAITING_USER");
		await expect(
			runtime.prepareOperation({
				toolCallId: "call-before-plan",
				toolName: "write",
				tier: "write",
				args: { path: "src/auth.ts" },
			}),
		).rejects.toThrow("SUCCESS_NOT_MEASURABLE");

		await activatePlan(runtime, "Run focused recovery tests");
		expect(runtime.state?.readiness).toMatchObject({ ready: true, blockers: [] });
	});

	it("blocks mutations while a ready task is suspended", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		const goal = createGoal();
		await runtime.handleGoalEvent({ type: "created", goal });
		await activatePlan(runtime);
		await runtime.handleGoalEvent({ type: "paused", goal, reason: "user" });

		expect(runtime.state?.phase).toBe("SUSPENDED");
		expect(runtime.buildContext()).toContain("Writes allowed: false");
		await expect(
			runtime.prepareOperation({
				toolCallId: "call-suspended",
				toolName: "write",
				tier: "write",
				args: { path: "src/auth.ts" },
			}),
		).rejects.toThrow("Task mutations are disabled during SUSPENDED");
	});

	it("flushes a prepared mutation before execution and recovers it after restart", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);
		harness.events.length = 0;

		const operation = await runtime.prepareOperation({
			toolCallId: "call-1",
			toolName: "write",
			tier: "write",
			args: { path: "src/auth.ts", content: "secret content is intentionally not journaled" },
		});

		expect(operation).toMatchObject({
			toolCallId: "call-1",
			toolName: "write",
			target: "src/auth.ts",
			status: "prepared",
		});
		if (!operation) throw new Error("expected prepared operation");
		expect(harness.events.indexOf("append:task-operation")).toBeLessThan(harness.events.indexOf("flush"));
		expect(runtime.state?.pendingOperationIds).toEqual([operation.id]);

		const restarted = new TaskLifecycleRuntime(harness.host);
		expect(restarted.state?.phase).toBe("RECOVERING");
		expect(restarted.state?.pendingOperationIds).toEqual([operation.id]);
		await expect(
			restarted.prepareOperation({
				toolCallId: "call-2",
				toolName: "bash",
				tier: "exec",
				args: { command: "deploy" },
			}),
		).rejects.toThrow(`reconcile prepared operation ${operation.id}`);

		const resolved = await restarted.resolveOperation(operation.id, "compensated");
		expect(resolved.status).toBe("compensated");
		expect(restarted.state?.pendingOperationIds).toEqual([]);
		expect(restarted.state).toMatchObject({
			phase: "RECONCILING",
			stalePlan: false,
			reconciliation: { stepId: "work-1", classification: "execution-failure" },
		});
		expect(restarted.state?.evidence.at(-1)?.summary).toBe("write was manually reconciled as compensated");
		await expect(
			restarted.prepareOperation({
				toolCallId: "call-3",
				toolName: "bash",
				tier: "exec",
				args: { command: "deploy" },
			}),
		).rejects.toThrow("Task reconciliation must be resolved");
	});

	it("rotates episodes and invalidates plan evidence when the workspace diverges", async () => {
		const harness = createHarness([
			createWorkspace(),
			createWorkspace(),
			createWorkspace(),
			createWorkspace({ dirtyTreeHash: "after-write" }),
			createWorkspace({ headCommit: "def", dirtyTreeHash: "external-change" }),
		]);
		const runtime = new TaskLifecycleRuntime(harness.host);
		const goal = createGoal();
		await runtime.handleGoalEvent({ type: "created", goal });
		await activatePlan(runtime);
		const firstEpisode = runtime.state?.episodeId;
		const operation = await runtime.prepareOperation({
			toolCallId: "call-1",
			toolName: "write",
			tier: "write",
			args: { path: "src/auth.ts" },
		});
		await runtime.settleOperation("call-1", false);
		expect(operation).toBeDefined();
		expect(runtime.state?.evidence).toHaveLength(1);

		harness.setSessionId("session-2");
		harness.advance(1_000);
		await runtime.handleGoalEvent({ type: "thread_resumed", goal, active: true });

		expect(runtime.state?.sessionId).toBe("session-2");
		expect(runtime.state?.episodeId).not.toBe(firstEpisode);
		expect(runtime.state?.phase).toBe("RECOVERING");
		expect(runtime.state?.stalePlan).toBe(true);
		expect(runtime.state?.evidence.every(item => item.stale)).toBe(true);
	});

	it("refuses completion when the live workspace no longer matches the verified plan", async () => {
		const harness = createHarness([
			createWorkspace(),
			createWorkspace(),
			createWorkspace({ headCommit: "external", dirtyTreeHash: "changed" }),
		]);
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);

		await expect(runtime.assertCompletionReady()).rejects.toThrow(
			"cannot complete task until the workspace is reconciled and the stale plan is updated",
		);
		expect(runtime.state).toMatchObject({
			phase: "RECOVERING",
			stalePlan: true,
			plan: { status: "stale" },
		});
	});

	it("revises one task by versioning its specification and invalidating the plan", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		const goal = createGoal();
		await runtime.handleGoalEvent({ type: "created", goal });

		const revised = createGoal({
			objective: goal.objective.replace("Ship lifecycle recovery.", "Ship lifecycle recovery without Redis."),
			updatedAt: 200,
		});
		await runtime.handleGoalEvent({ type: "revised", previousGoal: goal, goal: revised });

		expect(runtime.state).toMatchObject({
			taskId: "task-1",
			specVersion: 2,
			planVersion: 2,
			phase: "REPLANNING",
			stalePlan: true,
		});
		expect(runtime.state?.specification.goal).toBe("Ship lifecycle recovery without Redis.");
	});

	it("carries deterministic task state into a new handoff session", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });
		await activatePlan(runtime);
		const taskId = runtime.state?.taskId;
		const firstEpisode = runtime.state?.episodeId;
		const handoff = await runtime.prepareHandoff();
		if (!handoff) throw new Error("expected handoff");

		harness.entries.length = 0;
		harness.setSessionId("session-2");
		await runtime.resumeHandoff(handoff);

		expect(runtime.state).toMatchObject({
			taskId,
			sessionId: "session-2",
			phase: "READY",
		});
		expect(runtime.state?.episodeId).not.toBe(firstEpisode);
		expect(harness.entries.length).toBeGreaterThan(0);
	});

	it("requests a knowledge review only after verified completion", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		const goal = createGoal();
		await runtime.handleGoalEvent({ type: "created", goal });
		await activatePlan(runtime);

		const workOperation = await runtime.prepareOperation({
			toolCallId: "call-work",
			toolName: "write",
			tier: "write",
			args: { path: "src/lifecycle.ts" },
		});
		await runtime.settleOperation("call-work", false);
		const workEvidenceId = runtime.state?.evidence.find(item => item.operationId === workOperation?.id)?.id;
		if (!workEvidenceId) throw new Error("expected work evidence");
		await runtime.reportStepResult({
			stepId: "work-1",
			status: "completed",
			evidenceIds: [workEvidenceId],
			unexpectedEffects: [],
		});
		await expect(runtime.assertCompletionReady()).rejects.toThrow("plan steps remain");
		await runtime.prepareOperation({
			toolCallId: "call-validation",
			toolName: "bash",
			tier: "exec",
			args: { command: "bun test task-lifecycle.test.ts" },
		});
		await runtime.settleOperation("call-validation", false);
		const verification = runtime.state?.evidence.at(-1);
		expect(verification).toMatchObject({
			type: "verification",
			outcome: "passed",
			trust: "verified",
			validator: "bun test task-lifecycle.test.ts",
			verificationIds: ["V-1"],
		});
		if (!verification) throw new Error("expected verification evidence");
		await runtime.submitVerification({ stepId: "verify-1", evidenceIds: [verification.id] });
		await runtime.assertCompletionReady();
		await runtime.handleGoalEvent({ type: "completed", goal: { ...goal, status: "complete" } });

		expect(harness.knowledgeReviews).toHaveLength(1);
		expect(harness.knowledgeReviews[0]).toMatchObject({
			phase: "COMPLETED",
			specification: { goal: "Ship lifecycle recovery." },
		});
	});
});
