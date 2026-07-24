import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { WorkflowConfig } from "./config";
import type { WorkflowStore } from "./store";

interface CoordinatorResponse {
	version?: number;
}

export interface WorkspaceLeaseInput {
	workspaceId: string;
	taskId: string;
	attemptId: string;
	episodeId: string;
	machineId: string;
	leaseMs: number;
}

export class CoordinatorVersionConflictError extends Error {
	constructor(readonly currentVersion: number) {
		super(`workflow coordinator version conflict at version ${currentVersion}`);
		this.name = "CoordinatorVersionConflictError";
	}
}

export class WorkspaceLeaseConflictError extends Error {
	constructor(readonly workspaceId: string) {
		super(`workspace ${workspaceId} is leased by another task episode`);
		this.name = "WorkspaceLeaseConflictError";
	}
}

export class WorkflowCoordinatorClient {
	readonly #baseUrl: string;
	readonly #requestTimeoutMs: number;

	constructor(config: WorkflowConfig & { coordinatorUrl: string }) {
		this.#baseUrl = config.coordinatorUrl.replace(/\/+$/, "");
		this.#requestTimeoutMs = config.requestTimeoutMs;
	}

	async #post(pathname: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<CoordinatorResponse> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
		const response = await fetch(`${this.#baseUrl}${pathname}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.#requestTimeoutMs),
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (response.status === 409) {
			const currentVersion =
				isRecord(payload) && typeof payload.currentVersion === "number" ? payload.currentVersion : 0;
			throw new CoordinatorVersionConflictError(currentVersion);
		}
		if (!response.ok) {
			throw new Error(`workflow coordinator request failed: ${response.status} ${response.statusText}`);
		}
		return isRecord(payload) && typeof payload.version === "number" ? { version: payload.version } : {};
	}

	async flush(store: WorkflowStore): Promise<void> {
		for (const item of store.pendingCoordinator()) {
			const taskId = typeof item.request.taskId === "string" ? item.request.taskId : undefined;
			const expectedVersion = taskId ? store.coordinatorVersion(taskId) : undefined;
			try {
				const request = expectedVersion === undefined ? item.request : { ...item.request, expectedVersion };
				const response = await this.#post(item.path, request, item.id);
				if (taskId) {
					const currentVersion = expectedVersion ?? 0;
					store.setCoordinatorVersion(taskId, response.version ?? currentVersion + 1);
				}
				store.markCoordinatorDelivered(item.id);
			} catch (error) {
				if (error instanceof CoordinatorVersionConflictError && taskId) {
					store.setCoordinatorVersion(taskId, error.currentVersion);
					try {
						const response = await this.#post(
							item.path,
							{ ...item.request, expectedVersion: error.currentVersion },
							item.id,
						);
						store.setCoordinatorVersion(taskId, response.version ?? error.currentVersion + 1);
						store.markCoordinatorDelivered(item.id);
						continue;
					} catch (retryError) {
						logger.debug("Workflow coordinator conflict retry failed", { error: String(retryError), taskId });
					}
				}
				store.markCoordinatorRetry(item.id, item.attempts);
				throw error;
			}
		}
	}

	async acquireWorkspace(input: WorkspaceLeaseInput): Promise<void> {
		try {
			await this.#post(`/v1/workspaces/${encodeURIComponent(input.workspaceId)}/acquire`, {
				taskId: input.taskId,
				attemptId: input.attemptId,
				episodeId: input.episodeId,
				machineId: input.machineId,
				leaseMs: input.leaseMs,
			});
		} catch (error) {
			if (error instanceof CoordinatorVersionConflictError) {
				throw new WorkspaceLeaseConflictError(input.workspaceId);
			}
			throw error;
		}
	}

	async releaseWorkspace(input: WorkspaceLeaseInput): Promise<void> {
		await this.#post(`/v1/workspaces/${encodeURIComponent(input.workspaceId)}/release`, {
			taskId: input.taskId,
			attemptId: input.attemptId,
			episodeId: input.episodeId,
			machineId: input.machineId,
		});
	}

	async heartbeat(episodeId: string, machineId: string): Promise<void> {
		await this.#post(`/v1/episodes/${encodeURIComponent(episodeId)}/heartbeat`, { machineId });
	}
}
