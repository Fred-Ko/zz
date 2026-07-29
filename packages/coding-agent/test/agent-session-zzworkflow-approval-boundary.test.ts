import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { TaskPlan } from "@oh-my-pi/pi-coding-agent/goals/task-lifecycle";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const planSchema = z.object({ valid: z.boolean() });
const patchSchema = z.object({});
const executionSchema = z.object({ command: z.string() });

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
	mock: MockModel;
	executionCount: () => number;
};

const activeHarnesses: Harness[] = [];

function planCall(valid: boolean, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "zzw_propose_plan", arguments: { valid } }],
		stopReason: "toolUse",
	};
}

function executionCall(id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "execution_probe", arguments: { command: "write" } }],
		stopReason: "toolUse",
	};
}

function planAndExecutionCall(planId: string, executionId: string): MockResponse {
	return {
		content: [
			{ type: "toolCall", id: planId, name: "zzw_propose_plan", arguments: { valid: true } },
			{
				type: "toolCall",
				id: executionId,
				name: "execution_probe",
				arguments: { command: "write-in-same-batch" },
			},
		],
		stopReason: "toolUse",
	};
}

function patchAndExecutionCall(patchId: string, executionId: string): MockResponse {
	return {
		content: [
			{ type: "toolCall", id: patchId, name: "zzw_patch_plan", arguments: {} },
			{
				type: "toolCall",
				id: executionId,
				name: "execution_probe",
				arguments: { command: "write-after-material-patch" },
			},
		],
		stopReason: "toolUse",
	};
}

async function proposeTestPlan(session: AgentSession, valid: boolean): Promise<TaskPlan> {
	const specification = session.taskLifecycle.state?.specification;
	return await session.taskLifecycle.proposePlan({
		basedOnSpecVersion: 1,
		steps: [
			{
				id: "implement",
				phase: "Implementation",
				content: "Implement the approved change",
				kind: "work",
				dependsOn: [],
				expectedEffects: ["Source changes"],
				allowedTools: ["write"],
				allowedTargets: [],
				postconditions: ["Implementation exists"],
				successConditionIds: [],
				verificationIds: [],
				validators: [],
				rerunPolicy: "safe",
				riskClass: "low",
			},
			{
				id: "verify",
				phase: "Validation",
				content: "bun test focused.test.ts",
				kind: "validation",
				dependsOn: ["implement"],
				expectedEffects: [],
				allowedTools: ["bash"],
				allowedTargets: [],
				postconditions: ["Focused test passes"],
				successConditionIds: valid ? (specification?.successCriteria?.map(criterion => criterion.id) ?? []) : [],
				verificationIds: valid
					? (specification?.verificationRequirements?.map(requirement => requirement.id) ?? [])
					: [],
				validators: ["bun test focused.test.ts"],
				rerunPolicy: "safe",
				riskClass: "low",
			},
		],
	});
}

async function createHarness(responses: MockResponse[], options?: { approvedPlan?: boolean }): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-zzworkflow-approval-boundary-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"retry.enabled": false,
		"todo.enabled": true,
		"todo.eager": "default",
		"todo.reminders": true,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	let session: AgentSession | undefined;
	let executed = 0;
	const planTool: AgentTool<typeof planSchema> = {
		name: "zzw_propose_plan",
		label: "ZZWorkflow Plan Proposal",
		description: "Propose an executable Plan DAG.",
		parameters: planSchema,
		concurrency: "exclusive",
		async execute(_toolCallId, params) {
			if (!session) throw new Error("session is not initialized");
			const plan = await proposeTestPlan(session, params.valid);
			return {
				content: [{ type: "text", text: `Plan DAG v${plan.version} 제안 완료 · 사용자 승인 대기` }],
				details: plan,
			};
		},
	};
	const patchTool: AgentTool<typeof patchSchema> = {
		name: "zzw_patch_plan",
		label: "ZZWorkflow Plan Patch",
		description: "Propose a material Plan patch.",
		parameters: patchSchema,
		concurrency: "exclusive",
		async execute() {
			if (!session) throw new Error("session is not initialized");
			const plan = await session.taskLifecycle.patchPlan({
				basedOnPlanVersion: 2,
				addSteps: [],
				updateSteps: [{ id: "implement", allowedTools: ["write", "github"] }],
				removeStepIds: [],
				preserveStepIds: [],
				contradictedAssumptions: [],
				failedStepIds: [],
				rationale: "The implementation now needs external repository mutation authority",
			});
			return {
				content: [{ type: "text", text: `Plan DAG v${plan.version} 중요 변경 · 사용자 재승인 대기` }],
				details: plan,
			};
		},
	};
	const executionTool: AgentTool<typeof executionSchema> = {
		name: "execution_probe",
		label: "Execution Probe",
		description: "Probe whether a post-plan execution call was attempted.",
		parameters: executionSchema,
		async execute() {
			executed += 1;
			return { content: [{ type: "text", text: "executed" }], details: {} };
		},
	};
	const tools = [planTool, patchTool, executionTool] as AgentTool[];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	await session.goalRuntime.createGoal({
		objective: [
			"## Objective",
			"Implement an approved change.",
			"## Success criteria",
			"- The focused test passes.",
			"## Verification",
			"- bun test focused.test.ts",
		].join("\n"),
		controller: "zzworkflow",
	});
	if (options?.approvedPlan) {
		await proposeTestPlan(session, true);
		await session.taskLifecycle.approvePlan();
	}

	const harness = { session, authStorage, tempDir, mock, executionCount: () => executed };
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("AgentSession ZZWorkflow approval boundary", () => {
	it("ends the provider loop immediately after an accepted Plan proposal", async () => {
		const harness = await createHarness([
			planAndExecutionCall("call-plan", "call-execution-in-same-batch"),
			executionCall("call-execution-that-must-not-run"),
		]);

		await harness.session.prompt("Propose the plan and continue implementing.");
		await harness.session.waitForIdle();

		expect(harness.mock.calls).toHaveLength(1);
		expect(harness.executionCount()).toBe(0);
		expect(harness.session.taskLifecycle.state).toMatchObject({
			phase: "AWAITING_USER",
			plan: { version: 2, approval: "draft" },
		});
	});

	it("keeps the same turn alive when the proposed Plan is invalid", async () => {
		const harness = await createHarness([
			planCall(false, "call-invalid-plan"),
			{ content: ["I will repair the invalid plan."], stopReason: "stop" },
		]);

		await harness.session.prompt("Propose a valid plan.");
		await harness.session.waitForIdle();

		expect(harness.mock.calls.length).toBeGreaterThan(1);
		expect(harness.session.taskLifecycle.state).toMatchObject({
			phase: "AWAITING_USER",
			plan: { version: 1, approval: "draft" },
		});
	});

	it("ends the provider loop when a material Plan patch requires renewed approval", async () => {
		const harness = await createHarness(
			[
				patchAndExecutionCall("call-material-patch", "call-execution-after-patch"),
				executionCall("call-next-provider-execution-after-patch"),
			],
			{ approvedPlan: true },
		);

		await harness.session.prompt("Expand the approved implementation authority and continue.");
		await harness.session.waitForIdle();

		expect(harness.mock.calls).toHaveLength(1);
		expect(harness.executionCount()).toBe(0);
		expect(harness.session.taskLifecycle.state).toMatchObject({
			phase: "AWAITING_USER",
			plan: { version: 3, approval: "draft", approvalImpact: "material" },
		});
	});
});
