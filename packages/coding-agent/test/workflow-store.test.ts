import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkflowStore } from "../src/workflow/store";

const stores: WorkflowStore[] = [];
const dirs: string[] = [];

async function createStore(): Promise<WorkflowStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-store-"));
	dirs.push(dir);
	const store = new WorkflowStore(path.join(dir, "workflow.db"));
	stores.push(store);
	return store;
}

afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow local outbox", () => {
	it("coalesces queued mutable documents but preserves immutable events", async () => {
		const store = await createStore();
		store.enqueueMemory({
			id: "summary-v1",
			bankId: "repo",
			documentId: "task/T-1/current-summary",
			contentHash: "v1",
			request: { content: "version 1" },
			mutable: true,
		});
		store.enqueueMemory({
			id: "summary-v2",
			bankId: "repo",
			documentId: "task/T-1/current-summary",
			contentHash: "v2",
			request: { content: "version 2" },
			mutable: true,
		});
		store.enqueueMemory({
			id: "event-1",
			bankId: "repo",
			documentId: "event/E-1",
			contentHash: "event",
			request: { content: "immutable" },
			mutable: false,
		});

		expect(store.pendingMemory().map(item => item.id)).toEqual(["summary-v2", "event-1"]);
	});

	it("persists optimistic coordinator versions independently by task", async () => {
		const store = await createStore();
		store.setCoordinatorVersion("TASK-1", 7);
		store.setCoordinatorVersion("TASK-2", 3);

		expect(store.coordinatorVersion("TASK-1")).toBe(7);
		expect(store.coordinatorVersion("TASK-2")).toBe(3);
		expect(store.coordinatorVersion("TASK-3")).toBe(0);
	});
});
