import { describe, expect, it } from "bun:test";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	type TaskLifecycleHost,
	type TaskLifecycleJournalEntry,
	TaskLifecycleRuntime,
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

function createHarness(workspaces: TaskWorkspaceSnapshot[] = [createWorkspace()]) {
	const entries: TaskLifecycleJournalEntry[] = [];
	const events: string[] = [];
	const memories: Array<{ content: string; context: string }> = [];
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
		retainTaskMemory: memory => {
			memories.push(memory);
		},
		syncSharedState: async (_state, reason) => {
			sharedReasons.push(reason);
		},
		recallTaskMemory: async (_state, stage) => {
			recallStages.push(stage);
			return '<memory-context source="hindsight" authoritative="false">advisory</memory-context>';
		},
		now: () => now,
		mintId: kind => `${kind}-${++id}`,
	};
	return {
		host,
		entries,
		events,
		memories,
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
			phase: "READY",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			readiness: { ready: true },
		});
		expect(state?.specification.successConditions).toEqual(["A prepared write survives restart."]);
		expect(state?.specification.verification).toEqual(["bun test task-lifecycle.test.ts"]);
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
		expect(runtime.buildContext()).toContain('<task_lifecycle authoritative="true"');
		expect(runtime.buildContext()).toContain("Required next action: run_required_validation");
		expect(runtime.buildContext()).toContain('authoritative="false"');
	});

	it("versions a phase-barrier plan DAG and attaches mutations to its active step", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });

		await runtime.syncPlan([
			{
				name: "Implementation",
				tasks: [
					{ content: "Add the journal", status: "completed" },
					{ content: "Verify restart recovery", status: "in_progress" },
				],
			},
			{
				name: "Validation",
				tasks: [{ content: "Run the lifecycle suite", status: "pending" }],
			},
		]);

		expect(runtime.state).toMatchObject({
			planVersion: 2,
			stalePlan: false,
			plan: {
				version: 2,
				status: "current",
			},
		});
		expect(runtime.state?.plan.steps[0]).toMatchObject({ content: "Add the journal", dependsOn: [] });
		expect(runtime.state?.plan.steps[1]).toMatchObject({
			content: "Verify restart recovery",
			status: "in_progress",
			dependsOn: [],
		});
		const implementationStepIds = runtime.state?.plan.steps.slice(0, 2).map(step => step.id);
		expect(runtime.state?.plan.steps[2]?.dependsOn).toEqual(implementationStepIds);
		const activeStepId = runtime.state?.plan.steps[1]?.id;
		const operation = await runtime.prepareOperation({
			toolCallId: "call-plan",
			toolName: "bash",
			tier: "exec",
			args: { command: "bun test" },
		});
		expect(operation?.planStepId).toBe(activeStepId);
	});

	it("blocks an unstructured task until the persisted plan defines validation", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({
			type: "created",
			goal: createGoal({ objective: "Fix lifecycle recovery." }),
		});

		expect(runtime.state?.readiness).toMatchObject({
			ready: false,
			successMeasurable: false,
			blockers: [{ code: "SUCCESS_NOT_MEASURABLE" }],
		});
		expect(runtime.state?.phase).toBe("PREPARATION");
		await expect(
			runtime.prepareOperation({
				toolCallId: "call-before-plan",
				toolName: "write",
				tier: "write",
				args: { path: "src/auth.ts" },
			}),
		).rejects.toThrow("SUCCESS_NOT_MEASURABLE");

		await runtime.syncPlan([
			{
				name: "Implementation",
				tasks: [{ content: "Fix lifecycle recovery", status: "in_progress" }],
			},
			{
				name: "Validation",
				tasks: [{ content: "Run focused recovery tests", status: "pending" }],
			},
		]);
		expect(runtime.state?.readiness).toMatchObject({ ready: true, blockers: [] });
	});

	it("blocks mutations while a ready task is suspended", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		const goal = createGoal();
		await runtime.handleGoalEvent({ type: "created", goal });
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
		expect(restarted.state).toMatchObject({ phase: "REPLANNING", stalePlan: true });
		expect(restarted.state?.evidence.at(-1)?.summary).toBe("write was manually reconciled as compensated");
		await expect(
			restarted.prepareOperation({
				toolCallId: "call-3",
				toolName: "bash",
				tier: "exec",
				args: { command: "deploy" },
			}),
		).rejects.toThrow("Task plan is stale");
	});

	it("rotates episodes and invalidates plan evidence when the workspace diverges", async () => {
		const harness = createHarness([
			createWorkspace(),
			createWorkspace(),
			createWorkspace({ dirtyTreeHash: "after-write" }),
			createWorkspace({ headCommit: "def", dirtyTreeHash: "external-change" }),
		]);
		const runtime = new TaskLifecycleRuntime(harness.host);
		const goal = createGoal();
		await runtime.handleGoalEvent({ type: "created", goal });
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
			createWorkspace({ headCommit: "external", dirtyTreeHash: "changed" }),
		]);
		const runtime = new TaskLifecycleRuntime(harness.host);
		await runtime.handleGoalEvent({ type: "created", goal: createGoal() });

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

	it("promotes only confirmed task facts to long-term memory after completion", async () => {
		const harness = createHarness();
		const runtime = new TaskLifecycleRuntime(harness.host);
		const goal = createGoal();
		await runtime.handleGoalEvent({ type: "created", goal });

		await expect(runtime.assertCompletionReady()).rejects.toThrow("current verification evidence");
		await runtime.prepareOperation({
			toolCallId: "call-validation",
			toolName: "bash",
			tier: "exec",
			args: { command: "bun test task-lifecycle.test.ts" },
		});
		await runtime.settleOperation("call-validation", false);
		expect(runtime.state?.evidence.at(-1)).toMatchObject({
			type: "verification",
			outcome: "passed",
			validator: "bun test task-lifecycle.test.ts",
		});
		await runtime.handleGoalEvent({ type: "completed", goal: { ...goal, status: "complete" } });

		expect(harness.memories).toHaveLength(1);
		expect(harness.memories[0]?.content).toContain("Ship lifecycle recovery.");
		expect(harness.memories[0]?.content).toContain("A prepared write survives restart.");
		expect(harness.memories[0]?.context).toBe("Verified coding task outcome");
	});
});
