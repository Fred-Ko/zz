import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowConfig } from "../src/workflow/config";
import { WorkflowCoordinatorClient, WorkspaceLeaseConflictError } from "../src/workflow/coordinator";
import { WorkflowStore } from "../src/workflow/store";

const servers: Bun.Server<undefined>[] = [];
const stores: WorkflowStore[] = [];
const dirs: string[] = [];

function config(baseUrl: string): WorkflowConfig & { coordinatorUrl: string } {
	return {
		coordinatorUrl: baseUrl,
		machineIdFile: "/tmp/machine-id",
		requestTimeoutMs: 1_000,
		heartbeatIntervalMs: 15_000,
		staleAfterMs: 60_000,
		workspaceLeaseMs: 90_000,
		degradedAllowExecution: true,
		checkpointRemote: null,
	};
}

async function createStore(): Promise<WorkflowStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-coordinator-"));
	dirs.push(dir);
	const store = new WorkflowStore(path.join(dir, "workflow.db"));
	stores.push(store);
	return store;
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const store of stores.splice(0)) store.close();
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow coordinator client", () => {
	it("retries a queued event against the authoritative version after a conflict", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				bodies.push((await request.json()) as Record<string, unknown>);
				if (bodies.length === 1)
					return Response.json({ error: "version_conflict", currentVersion: 4 }, { status: 409 });
				return Response.json({ version: 5 });
			},
		});
		servers.push(server);
		const store = await createStore();
		store.enqueueCoordinator({
			id: "event-1",
			path: "/v1/tasks",
			request: { taskId: "TASK-1", state: "READY" },
		});

		await new WorkflowCoordinatorClient(config(server.url.toString())).flush(store);

		expect(bodies.map(body => body.expectedVersion)).toEqual([0, 4]);
		expect(store.coordinatorVersion("TASK-1")).toBe(5);
		expect(store.pendingCoordinator()).toHaveLength(0);
	});

	it("surfaces a workspace lease conflict instead of entering degraded mode", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ error: "version_conflict", currentVersion: 2 }, { status: 409 }),
		});
		servers.push(server);
		const client = new WorkflowCoordinatorClient(config(server.url.toString()));

		await expect(
			client.acquireWorkspace({
				workspaceId: "workspace-1",
				taskId: "TASK-1",
				attemptId: "ATTEMPT-1",
				episodeId: "EPISODE-1",
				machineId: "MACHINE-1",
				leaseMs: 90_000,
			}),
		).rejects.toBeInstanceOf(WorkspaceLeaseConflictError);
	});
});
