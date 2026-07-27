import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	defaultZZWorkflowDbPath,
	type LocalWorkspaceLeaseInput,
	openRepositoryZZWorkflowStore,
	repositoryZZWorkflowDbPath,
	ZZWorkflowStore,
} from "../src/workflow/store";

const stores: ZZWorkflowStore[] = [];
const dirs: string[] = [];

async function createDatabasePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zz-workflow-store-"));
	dirs.push(dir);
	return path.join(dir, "workflow.db");
}

async function createAgentDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zz-workflow-agent-"));
	dirs.push(dir);
	return dir;
}

function createStore(databasePath: string, now: () => number = Date.now): ZZWorkflowStore {
	const store = new ZZWorkflowStore(databasePath, { now });
	stores.push(store);
	return store;
}

afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("local workflow SQLite store", () => {
	it("records task state atomically and makes repeated events idempotent", async () => {
		const now = Date.parse("2026-07-25T00:00:00.000Z");
		const store = createStore(await createDatabasePath(), () => now);
		const event = {
			id: "task-created",
			taskId: "TASK-1",
			repoId: "repo-1",
			kind: "created",
			payload: { state: { phase: "READY", title: "Local workflow" } },
		};

		expect(store.recordEvent(event)).toEqual({ version: 1 });
		expect(store.recordEvent(event)).toEqual({ version: 1 });
		expect(store.recordEvent({ ...event, id: "task-updated", kind: "plan-updated" })).toEqual({ version: 2 });
		expect(store.getTask("TASK-1")).toEqual({
			taskId: "TASK-1",
			repoId: "repo-1",
			phase: "READY",
			version: 2,
			state: { phase: "READY", title: "Local workflow" },
			updatedAt: "2026-07-25T00:00:00.000Z",
		});
	});

	it("returns the newest local checkpoint and episode in a recovery snapshot", async () => {
		const store = createStore(await createDatabasePath());
		store.recordEvent({
			id: "episode-1",
			taskId: "TASK-1",
			kind: "episode-started",
			payload: { episodeId: "EPISODE-1", state: { phase: "EXECUTING" } },
		});
		store.recordEvent({
			id: "checkpoint-1",
			taskId: "TASK-1",
			kind: "checkpoint",
			payload: { checkpoint: { commit: "abc123" }, state: { phase: "SUSPENDED" } },
		});
		store.recordEvent({
			id: "checkpoint-2",
			taskId: "TASK-1",
			kind: "checkpoint",
			payload: { checkpoint: { commit: "def456" }, state: { phase: "SUSPENDED" } },
		});

		expect(store.getRecovery("TASK-1")).toMatchObject({
			task: { taskId: "TASK-1", version: 3 },
			latestCheckpoint: { checkpoint: { commit: "def456" } },
			lastEpisode: { episodeId: "EPISODE-1" },
		});
	});

	it("coordinates leases across local ZZ processes and permits takeover after expiry", async () => {
		let now = 1_000;
		const databasePath = await createDatabasePath();
		const first = createStore(databasePath, () => now);
		const second = createStore(databasePath, () => now);
		const owner: LocalWorkspaceLeaseInput = {
			workspaceId: "workspace-1",
			taskId: "TASK-1",
			attemptId: "ATTEMPT-1",
			episodeId: "EPISODE-1",
			leaseMs: 100,
		};
		const competitor: LocalWorkspaceLeaseInput = {
			...owner,
			attemptId: "ATTEMPT-2",
			episodeId: "EPISODE-2",
		};

		expect(first.acquireLease(owner)).toBe(true);
		expect(second.acquireLease(competitor)).toBe(false);
		now = 1_050;
		expect(first.heartbeat(owner.episodeId)).toBe(true);
		now = 1_120;
		expect(second.acquireLease(competitor)).toBe(false);
		now = 1_151;
		expect(second.acquireLease(competitor)).toBe(true);
		expect(first.heartbeat(owner.episodeId)).toBe(false);
		expect(first.acquireLease(owner)).toBe(false);

		second.releaseLease(competitor);
		expect(first.acquireLease(owner)).toBe(true);
	});

	it("isolates each repository in its own workflow database path", async () => {
		const agentDir = await createAgentDir();

		expect(repositoryZZWorkflowDbPath("remote-0123456789abcdef", agentDir)).toBe(
			path.join(agentDir, "workflows", "remote-0123456789abcdef", "workflow.db"),
		);
		expect(repositoryZZWorkflowDbPath("../../unsafe repository", agentDir)).toMatch(
			new RegExp(`^${path.join(agentDir, "workflows").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]`),
		);
		expect(repositoryZZWorkflowDbPath("../../unsafe repository", agentDir)).not.toContain("..");
	});

	it("defers legacy migration while its repository lease is active, then migrates only matching state", async () => {
		let now = 1_000;
		const agentDir = await createAgentDir();
		const legacy = createStore(defaultZZWorkflowDbPath(agentDir), () => now);
		legacy.recordEvent({
			id: "repo-a-created",
			taskId: "TASK-A",
			repoId: "repo-a",
			kind: "created",
			payload: { state: { phase: "EXECUTING", episodeId: "EPISODE-A" } },
		});
		legacy.recordEvent({
			id: "repo-b-created",
			taskId: "TASK-B",
			repoId: "repo-b",
			kind: "created",
			payload: { state: { phase: "READY", episodeId: "EPISODE-B" } },
		});
		const owner: LocalWorkspaceLeaseInput = {
			workspaceId: "workspace-a",
			taskId: "TASK-A",
			attemptId: "ATTEMPT-A",
			episodeId: "EPISODE-A",
			leaseMs: 100,
		};
		expect(legacy.acquireLease(owner)).toBe(true);
		expect(legacy.heartbeat(owner.episodeId)).toBe(true);

		const deferred = openRepositoryZZWorkflowStore("repo-a", agentDir, { now: () => now });
		stores.push(deferred.store);
		expect(deferred.source).toBe("legacy-active");
		expect(deferred.migration).toBe("deferred-active-lease");
		expect(deferred.databasePath).toBe(defaultZZWorkflowDbPath(agentDir));

		now = 1_101;
		const migrated = openRepositoryZZWorkflowStore("repo-a", agentDir, { now: () => now });
		stores.push(migrated.store);
		expect(migrated.source).toBe("repository");
		expect(migrated.migration).toBe("migrated");
		expect(migrated.databasePath).toBe(repositoryZZWorkflowDbPath("repo-a", agentDir));
		expect(migrated.store.getTask("TASK-A")).toMatchObject({ repoId: "repo-a", version: 1 });
		expect(migrated.store.getTask("TASK-B")).toBeNull();
		expect(
			migrated.store.acquireLease({
				...owner,
				attemptId: "ATTEMPT-A2",
				episodeId: "EPISODE-A2",
			}),
		).toBe(true);

		legacy.recordEvent({
			id: "repo-a-late-update",
			taskId: "TASK-A",
			repoId: "repo-a",
			kind: "paused",
			payload: { state: { phase: "SUSPENDED", episodeId: "EPISODE-A" } },
		});
		const reopened = openRepositoryZZWorkflowStore("repo-a", agentDir, { now: () => now });
		stores.push(reopened.store);
		expect(reopened.migration).toBe("already-migrated");
		expect(reopened.databasePath).toBe(repositoryZZWorkflowDbPath("repo-a", agentDir));
		expect(reopened.store.getTask("TASK-A")).toMatchObject({
			phase: "SUSPENDED",
			version: 2,
			state: { phase: "SUSPENDED" },
		});
	});
});
