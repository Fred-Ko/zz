import { afterEach, describe, expect, it } from "bun:test";
import { SqliteWorkflowRegistry } from "../src/sqlite-store";
import { WorkflowVersionConflictError, type WorkspaceLeaseInput } from "../src/types";

const stores: SqliteWorkflowRegistry[] = [];

function createStore(now: () => number = Date.now): SqliteWorkflowRegistry {
	const store = new SqliteWorkflowRegistry(":memory:", { now });
	stores.push(store);
	return store;
}

afterEach(async () => {
	await Promise.all(stores.splice(0).map(store => store.close()));
});

describe("SQLite workflow registry", () => {
	it("atomically preserves optimistic versions and idempotent event results", async () => {
		const store = createStore(() => Date.parse("2026-07-24T00:00:00.000Z"));
		await store.migrate();
		const event = {
			idempotencyKey: "event-1",
			taskId: "TASK-1",
			path: "/v1/tasks",
			expectedVersion: 0,
			payload: {
				repoId: "repo-1",
				state: { phase: "READY", title: "SQLite workflow" },
			},
		};

		expect(await store.applyEvent(event)).toEqual({ version: 1 });
		expect(await store.applyEvent(event)).toEqual({ version: 1 });
		expect(await store.getTask("TASK-1")).toEqual({
			taskId: "TASK-1",
			repoId: "repo-1",
			phase: "READY",
			version: 1,
			state: { phase: "READY", title: "SQLite workflow" },
			updatedAt: "2026-07-24T00:00:00.000Z",
		});

		await expect(
			store.applyEvent({
				...event,
				idempotencyKey: "event-2",
				expectedVersion: 0,
			}),
		).rejects.toEqual(new WorkflowVersionConflictError(1));
	});

	it("returns the newest checkpoint and episode in a recovery snapshot", async () => {
		let now = 1;
		const store = createStore(() => now++);
		await store.migrate();
		await store.applyEvent({
			idempotencyKey: "checkpoint-1",
			taskId: "TASK-1",
			path: "/v1/checkpoints",
			expectedVersion: 0,
			payload: { checkpointId: "CHECKPOINT-1" },
		});
		await store.applyEvent({
			idempotencyKey: "episode-1",
			taskId: "TASK-1",
			path: "/v1/episodes",
			expectedVersion: 1,
			payload: { episodeId: "EPISODE-1" },
		});
		await store.applyEvent({
			idempotencyKey: "checkpoint-2",
			taskId: "TASK-1",
			path: "/v1/checkpoints",
			expectedVersion: 2,
			payload: { checkpointId: "CHECKPOINT-2" },
		});

		expect(await store.getRecovery("TASK-1")).toMatchObject({
			task: { taskId: "TASK-1", version: 3 },
			latestCheckpoint: { checkpointId: "CHECKPOINT-2" },
			lastEpisode: { episodeId: "EPISODE-1" },
		});
	});

	it("blocks competing leases, renews the owner lease, and allows takeover after expiry", async () => {
		let now = 1_000;
		const store = createStore(() => now);
		await store.migrate();
		const owner: WorkspaceLeaseInput = {
			workspaceId: "workspace-1",
			taskId: "TASK-1",
			attemptId: "ATTEMPT-1",
			episodeId: "EPISODE-1",
			machineId: "MACHINE-1",
			leaseMs: 100,
		};
		const competitor: WorkspaceLeaseInput = {
			...owner,
			attemptId: "ATTEMPT-2",
			episodeId: "EPISODE-2",
			machineId: "MACHINE-2",
		};

		expect(await store.acquireLease(owner)).toBe(true);
		expect(await store.acquireLease(competitor)).toBe(false);
		now = 1_050;
		expect(await store.heartbeat({ episodeId: owner.episodeId, machineId: owner.machineId })).toBe(true);
		now = 1_120;
		expect(await store.acquireLease(competitor)).toBe(false);
		now = 1_151;
		expect(await store.acquireLease(competitor)).toBe(true);

		await store.releaseLease(competitor);
		expect(await store.acquireLease(owner)).toBe(true);
	});
});
