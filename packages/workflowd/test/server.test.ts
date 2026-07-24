import { describe, expect, it } from "bun:test";
import { createWorkflowHandler } from "../src/server";
import {
	type EpisodeHeartbeatInput,
	type WorkflowEventInput,
	type WorkflowEventResult,
	type WorkflowRecoveryRecord,
	type WorkflowRegistryStore,
	type WorkflowTaskRecord,
	WorkflowVersionConflictError,
	type WorkspaceLeaseInput,
} from "../src/types";

class FakeStore implements WorkflowRegistryStore {
	events: WorkflowEventInput[] = [];
	leaseAcquired = true;
	conflictVersion: number | undefined;

	async migrate(): Promise<void> {}

	async applyEvent(input: WorkflowEventInput): Promise<WorkflowEventResult> {
		if (this.conflictVersion !== undefined) throw new WorkflowVersionConflictError(this.conflictVersion);
		this.events.push(input);
		return { version: input.expectedVersion + 1 };
	}

	async acquireLease(_input: WorkspaceLeaseInput): Promise<boolean> {
		return this.leaseAcquired;
	}

	async releaseLease(_input: WorkspaceLeaseInput): Promise<void> {}

	async heartbeat(_input: EpisodeHeartbeatInput): Promise<boolean> {
		return true;
	}

	async getTask(_taskId: string): Promise<WorkflowTaskRecord | null> {
		return null;
	}

	async getRecovery(_taskId: string): Promise<WorkflowRecoveryRecord | null> {
		return null;
	}

	async close(): Promise<void> {}
}

function post(pathname: string, body: Record<string, unknown>, idempotencyKey?: string): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
	return new Request(`http://workflow.test${pathname}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

describe("workflow coordinator HTTP contract", () => {
	it("passes idempotency and optimistic version data to the registry", async () => {
		const store = new FakeStore();
		const response = await createWorkflowHandler(store)(
			post("/v1/tasks", { taskId: "TASK-1", expectedVersion: 7, state: { phase: "READY" } }, "event-1"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ version: 8 });
		expect(store.events[0]).toMatchObject({
			idempotencyKey: "event-1",
			taskId: "TASK-1",
			path: "/v1/tasks",
			expectedVersion: 7,
		});
	});

	it("maps store version conflicts to a retryable 409 response", async () => {
		const store = new FakeStore();
		store.conflictVersion = 9;

		const response = await createWorkflowHandler(store)(
			post("/v1/tasks", { taskId: "TASK-1", expectedVersion: 7 }, "event-1"),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "version_conflict", currentVersion: 9 });
	});

	it("rejects a workspace lease held by another episode", async () => {
		const store = new FakeStore();
		store.leaseAcquired = false;

		const response = await createWorkflowHandler(store)(
			post("/v1/workspaces/workspace-1/acquire", {
				taskId: "TASK-1",
				attemptId: "ATTEMPT-1",
				episodeId: "EPISODE-1",
				machineId: "MACHINE-1",
				leaseMs: 90_000,
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "workspace_lease_conflict" });
	});
});
