import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { Settings } from "../src/config/settings";
import type { Goal } from "../src/goals/state";
import {
	TASK_LIFECYCLE_ENTRY_TYPE,
	TASK_OPERATION_ENTRY_TYPE,
	type TaskLifecycleJournalEntry,
	TaskLifecycleRuntime,
} from "../src/goals/task-lifecycle";
import { resolveRepositoryIdentity } from "../src/workflow/identity";
import { ZZWorkflowIntegration } from "../src/workflow/integration";
import { repositoryZZWorkflowDbPath } from "../src/workflow/store";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zz-workflow-rebind-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function goal(): Goal {
	return {
		id: "task-rebind",
		objective: [
			"## Objective",
			"Verify repository hot rebinding.",
			"## Success criteria",
			"- The nested repository gets its own Workflow database.",
			"## Verification",
			"- bun test workflow-integration.test.ts",
		].join("\n"),
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("Workflow integration", () => {
	it("rebinds to a nested repository created after the session starts", async () => {
		const root = await createTempDir();
		const agentDir = path.join(root, "agent");
		const parent = path.join(root, "parent");
		const nested = path.join(parent, "demo");
		await fs.mkdir(nested, { recursive: true });
		await $`git init --initial-branch=main`.cwd(parent).quiet();
		await $`git remote add origin https://github.com/example/parent.git`.cwd(parent).quiet();
		const parentIdentity = await resolveRepositoryIdentity(nested);
		const settings = await Settings.loadIsolated({ cwd: nested, agentDir });
		const integration = new ZZWorkflowIntegration({
			settings,
			knowledgeEnabled: false,
			getCwd: () => nested,
			getSessionId: () => "session-rebind",
		});
		const entries: TaskLifecycleJournalEntry[] = [];
		const lifecycle = new TaskLifecycleRuntime({
			getSessionId: () => "session-rebind",
			getCwd: () => nested,
			getEntries: () => entries,
			appendCustomEntry: (customType, data) => {
				expect([TASK_LIFECYCLE_ENTRY_TYPE, TASK_OPERATION_ENTRY_TYPE]).toContain(customType);
				entries.push({ type: "custom", customType, data });
				return `entry-${entries.length}`;
			},
			ensureOnDisk: async () => {},
			flush: async () => {},
			syncZZWorkflowState: (state, reason) => integration.syncState(state, reason),
			syncZZWorkflowOperation: (state, operation, reason) => integration.syncOperation(state, operation, reason),
			assertMutationLease: state => integration.assertMutationLease(state),
		});

		await lifecycle.handleGoalEvent({ type: "created", goal: goal() });
		expect(await Bun.file(repositoryZZWorkflowDbPath(parentIdentity.repositoryId, agentDir)).exists()).toBe(true);

		await $`git init --initial-branch=main`.cwd(nested).quiet();
		const nestedIdentity = await resolveRepositoryIdentity(nested);
		expect(nestedIdentity.repositoryId).not.toBe(parentIdentity.repositoryId);
		await lifecycle.proposePlan({
			basedOnSpecVersion: 1,
			steps: [
				{
					id: "work",
					phase: "Implementation",
					content: "Write the nested repository marker",
					kind: "work",
					dependsOn: [],
					expectedEffects: ["Nested repository mutation"],
					allowedTools: ["write"],
					allowedTargets: [],
					postconditions: ["Operation is journaled"],
					successConditions: [],
					validators: [],
					rerunPolicy: "safe",
					riskClass: "low",
				},
				{
					id: "verify",
					phase: "Validation",
					content: "bun test workflow-integration.test.ts",
					kind: "validation",
					dependsOn: ["work"],
					expectedEffects: [],
					allowedTools: ["bash"],
					allowedTargets: [],
					postconditions: ["Test passes"],
					successConditions: ["The nested repository gets its own Workflow database."],
					validators: ["bun test workflow-integration.test.ts"],
					rerunPolicy: "safe",
					riskClass: "low",
				},
			],
		});
		await lifecycle.approvePlan();
		await lifecycle.prepareOperation({
			toolCallId: "nested-write",
			toolName: "write",
			tier: "write",
			args: { path: "marker.txt" },
		});
		await lifecycle.settleOperation("nested-write", false);

		expect(lifecycle.state?.workspace.repoId).toBe(nestedIdentity.repositoryId);
		expect(await Bun.file(repositoryZZWorkflowDbPath(nestedIdentity.repositoryId, agentDir)).exists()).toBe(true);
		await integration.close();
	});
});
