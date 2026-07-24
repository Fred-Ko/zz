import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { HindsightApi } from "../src/hindsight/client";
import { loadHindsightConfig } from "../src/hindsight/config";
import { WorkflowMemoryGateway } from "../src/hindsight/gateway";
import { WorkflowStore } from "../src/workflow/store";

const stores: WorkflowStore[] = [];
const dirs: string[] = [];

async function createStore(): Promise<WorkflowStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-memory-"));
	dirs.push(dir);
	const store = new WorkflowStore(path.join(dir, "workflow.db"));
	stores.push(store);
	return store;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow-managed Hindsight gateway", () => {
	it("recalls task and repository memory separately with strict tags", async () => {
		const store = await createStore();
		const client = new HindsightApi({ baseUrl: "http://hindsight.test" });
		vi.spyOn(client, "createBank").mockResolvedValue({});
		const recall = vi.spyOn(client, "recall").mockImplementation(async (_bankId, _query, options) => {
			if (options?.tags?.includes("task:TASK-1")) {
				return { results: [{ id: "task-memory", text: "Retry-only failed." }] };
			}
			return { results: [{ id: "repo-memory", text: "Run schema generation after auth edits." }] };
		});
		const gateway = new WorkflowMemoryGateway({
			client,
			config: loadHindsightConfig(
				Settings.isolated({
					"hindsight.integrationMode": "workflow-managed",
					"hindsight.userId": "user-1",
				}),
				{},
			),
			store,
			machineId: "machine-1",
			sessionId: "session-1",
			episodeId: () => "episode-1",
		});

		const result = await gateway.recallForPlanning({
			repoId: "repo-1",
			taskId: "TASK-1",
			goal: "Fix auth concurrency.",
		});

		expect(recall).toHaveBeenCalledTimes(3);
		expect(recall.mock.calls[0]?.[2]).toMatchObject({
			tags: ["repo:repo-1", "task:TASK-1"],
			tagsMatch: "all_strict",
		});
		expect(recall.mock.calls[1]?.[2]).toMatchObject({
			tags: ["repo:repo-1", "kind:repo-fact"],
			tagsMatch: "all_strict",
		});
		expect(result.degraded).toBe(false);
		expect(result.content).toContain("Retry-only failed.");
		expect(result.content).toContain("Run schema generation after auth edits.");
		expect(result.content).toContain('authoritative="false"');
	});

	it("redacts curated memory and attaches cross-machine provenance", async () => {
		const store = await createStore();
		const client = new HindsightApi({ baseUrl: "http://hindsight.test" });
		vi.spyOn(client, "createBank").mockResolvedValue({});
		const retain = vi.spyOn(client, "retain").mockResolvedValue({});
		const gateway = new WorkflowMemoryGateway({
			client,
			config: loadHindsightConfig(
				Settings.isolated({
					"hindsight.integrationMode": "workflow-managed",
					"hindsight.userId": "user-1",
				}),
				{},
			),
			store,
			machineId: "machine-1",
			sessionId: "session-1",
			episodeId: () => "episode-1",
			redact: content => content.replace("secret-token", "[REDACTED]"),
		});

		await gateway.retain({
			kind: "failed-approach",
			statement: "The secret-token retry strategy failed.",
			applicability: { repoId: "repo-1", taskId: "TASK-1" },
			evidence: [{ evidenceId: "EV-1", type: "test" }],
			confidence: "confirmed",
			attemptId: "ATTEMPT-2",
			specVersion: 4,
			planVersion: 7,
		});
		await gateway.flushOutbox();

		expect(retain).toHaveBeenCalledTimes(1);
		expect(retain.mock.calls[0]?.[1]).toBe("The [REDACTED] retry strategy failed.");
		expect(retain.mock.calls[0]?.[2]).toMatchObject({
			tags: [
				"repo:repo-1",
				"task:TASK-1",
				"attempt:ATTEMPT-2",
				"kind:failed-approach",
				"status:active",
				"source:agent",
				"spec:4",
			],
			metadata: {
				machine_id: "machine-1",
				omp_session_id: "session-1",
				episode_id: "episode-1",
				task_id: "TASK-1",
				evidence_id: "EV-1",
			},
		});
	});

	it("keeps the latest mutable task summary queued while Hindsight is unavailable", async () => {
		const store = await createStore();
		const client = new HindsightApi({ baseUrl: "http://hindsight.test" });
		vi.spyOn(client, "createBank").mockResolvedValue({});
		vi.spyOn(client, "retain").mockRejectedValue(new Error("offline"));
		const gateway = new WorkflowMemoryGateway({
			client,
			config: loadHindsightConfig(Settings.isolated({ "hindsight.integrationMode": "workflow-managed" }), {}),
			store,
			machineId: "machine-1",
			sessionId: "session-1",
			episodeId: () => "episode-1",
		});

		await gateway.replaceCurrentTaskSummary({ repoId: "repo-1", taskId: "TASK-1", summary: "version 1" });
		await gateway.flushOutbox();
		await gateway.replaceCurrentTaskSummary({ repoId: "repo-1", taskId: "TASK-1", summary: "version 2" });
		await gateway.flushOutbox();

		const queued = store.queuedMemory();
		expect(queued).toHaveLength(1);
		expect(queued[0]?.documentId).toBe("task/TASK-1/current-summary");
		expect(queued[0]?.request.content).toBe("version 2");
	});
});
