import {
	type EpisodeHeartbeatInput,
	type WorkflowEventInput,
	type WorkflowRegistryStore,
	WorkflowVersionConflictError,
	type WorkspaceLeaseInput,
} from "./types";

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await request.json();
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function stringField(body: Record<string, unknown>, key: string): string | null {
	const value = body[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function eventInput(request: Request, body: Record<string, unknown>): WorkflowEventInput | null {
	const taskId = stringField(body, "taskId");
	const expectedVersion = body.expectedVersion;
	const idempotencyKey = request.headers.get("Idempotency-Key");
	if (!taskId || !idempotencyKey || typeof expectedVersion !== "number") return null;
	return {
		idempotencyKey,
		taskId,
		path: new URL(request.url).pathname,
		expectedVersion,
		payload: body,
	};
}

function leaseInput(workspaceId: string, body: Record<string, unknown>): WorkspaceLeaseInput | null {
	const taskId = stringField(body, "taskId");
	const attemptId = stringField(body, "attemptId");
	const episodeId = stringField(body, "episodeId");
	const machineId = stringField(body, "machineId");
	const leaseMs = body.leaseMs;
	if (!taskId || !attemptId || !episodeId || !machineId || typeof leaseMs !== "number") return null;
	return { workspaceId, taskId, attemptId, episodeId, machineId, leaseMs };
}

export function createWorkflowHandler(store: WorkflowRegistryStore): (request: Request) => Promise<Response> {
	return async request => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

		const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
		if (request.method === "GET" && taskMatch?.[1]) {
			const task = await store.getTask(decodeURIComponent(taskMatch[1]));
			return task ? json(task) : json({ error: "not_found" }, 404);
		}
		const recoveryMatch = /^\/v1\/recovery\/([^/]+)$/.exec(url.pathname);
		if (request.method === "GET" && recoveryMatch?.[1]) {
			const recovery = await store.getRecovery(decodeURIComponent(recoveryMatch[1]));
			return recovery ? json(recovery) : json({ error: "not_found" }, 404);
		}

		if (request.method !== "POST") return json({ error: "not_found" }, 404);
		const body = await requestBody(request);
		if (!body) return json({ error: "invalid_json" }, 400);

		const acquireMatch = /^\/v1\/workspaces\/([^/]+)\/acquire$/.exec(url.pathname);
		if (acquireMatch?.[1]) {
			const input = leaseInput(decodeURIComponent(acquireMatch[1]), body);
			if (!input) return json({ error: "invalid_lease" }, 400);
			return (await store.acquireLease(input))
				? json({ acquired: true })
				: json({ error: "workspace_lease_conflict" }, 409);
		}
		const releaseMatch = /^\/v1\/workspaces\/([^/]+)\/release$/.exec(url.pathname);
		if (releaseMatch?.[1]) {
			const input = leaseInput(decodeURIComponent(releaseMatch[1]), { ...body, leaseMs: body.leaseMs ?? 0 });
			if (!input) return json({ error: "invalid_lease" }, 400);
			await store.releaseLease(input);
			return json({ released: true });
		}
		const heartbeatMatch = /^\/v1\/episodes\/([^/]+)\/heartbeat$/.exec(url.pathname);
		if (heartbeatMatch?.[1]) {
			const machineId = stringField(body, "machineId");
			if (!machineId) return json({ error: "invalid_heartbeat" }, 400);
			const input: EpisodeHeartbeatInput = {
				episodeId: decodeURIComponent(heartbeatMatch[1]),
				machineId,
			};
			await store.heartbeat(input);
			return json({ ok: true });
		}

		const input = eventInput(request, body);
		if (!input) return json({ error: "invalid_event" }, 400);
		try {
			return json(await store.applyEvent(input));
		} catch (error) {
			if (error instanceof WorkflowVersionConflictError) {
				return json({ error: "version_conflict", currentVersion: error.currentVersion }, 409);
			}
			throw error;
		}
	};
}
