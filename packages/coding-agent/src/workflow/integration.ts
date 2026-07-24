import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { TaskLifecycleMemory, TaskLifecycleState, TaskOperation } from "../goals/task-lifecycle";
import { createHindsightClient } from "../hindsight/client";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { WorkflowMemoryGateway } from "../hindsight/gateway";
import * as git from "../utils/git";
import { isWorkflowConfigured, loadWorkflowConfig, type WorkflowConfig } from "./config";
import { WorkflowCoordinatorClient, WorkspaceLeaseConflictError, type WorkspaceLeaseInput } from "./coordinator";
import { loadOrCreateMachineId, resolveRepositoryIdentity } from "./identity";
import { WorkflowStore } from "./store";

export type WorkflowSyncReason =
	| "created"
	| "replaced"
	| "revised"
	| "episode-started"
	| "plan-updated"
	| "operation-prepared"
	| "operation-settled"
	| "operation-reconciled"
	| "paused"
	| "handoff"
	| "completed"
	| "abandoned";

export type WorkflowRecallStage = "intake" | "planning" | "recovery";

export interface WorkflowIntegrationOptions {
	settings: Settings;
	getCwd(): string;
	getSessionId(): string;
	redact?(content: string): string;
}

interface WorkflowServices {
	config: WorkflowConfig;
	machineId: string;
	store: WorkflowStore;
	coordinator?: WorkflowCoordinatorClient;
	memory?: WorkflowMemoryGateway;
}

interface SharedCheckpoint {
	remote: string;
	ref: string;
	commit: string;
	unsharedLocalChanges: boolean;
}

function eventId(value: unknown): string {
	return `workflow-${Bun.hash(JSON.stringify(value)).toString(16).padStart(16, "0")}`;
}

function isTerminalOrSuspended(state: TaskLifecycleState): boolean {
	return (
		state.phase === "COMPLETED" ||
		state.phase === "ABANDONED" ||
		state.phase === "FAILED" ||
		state.phase === "SUSPENDED"
	);
}

function additionalCoordinatorPath(state: TaskLifecycleState, reason: WorkflowSyncReason): string | undefined {
	switch (reason) {
		case "revised":
			return `/v1/tasks/${encodeURIComponent(state.taskId)}/specs`;
		case "episode-started":
			return "/v1/episodes";
		case "plan-updated":
			return `/v1/plans/${encodeURIComponent(state.taskId)}/patch`;
		case "paused":
		case "handoff":
			return "/v1/checkpoints";
		case "completed":
			return "/v1/verifications";
		default:
			return undefined;
	}
}

function checkpointReason(reason: WorkflowSyncReason): boolean {
	return reason === "plan-updated" || reason === "paused" || reason === "handoff" || reason === "completed";
}

function refSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export class WorkflowIntegration {
	readonly #options: WorkflowIntegrationOptions;
	readonly #services: Promise<WorkflowServices | undefined>;
	#state: TaskLifecycleState | undefined;
	#leaseExpiresAt = 0;
	#heartbeatTimer: Timer | undefined;
	#closed = false;

	constructor(options: WorkflowIntegrationOptions) {
		this.#options = options;
		this.#services = this.#initialize();
	}

	async #initialize(): Promise<WorkflowServices | undefined> {
		const workflowConfig = loadWorkflowConfig(this.#options.settings);
		const hindsightConfig = loadHindsightConfig(this.#options.settings);
		const workflowMemory =
			this.#options.settings.get("memory.backend") === "hindsight" &&
			hindsightConfig.integrationMode === "workflow-managed" &&
			isHindsightConfigured(hindsightConfig);
		if (!isWorkflowConfigured(workflowConfig) && !workflowMemory) return undefined;

		const [machineId, repository] = await Promise.all([
			loadOrCreateMachineId(workflowConfig.machineIdFile),
			resolveRepositoryIdentity(this.#options.getCwd()),
		]);
		const store = new WorkflowStore();
		const coordinator = isWorkflowConfigured(workflowConfig)
			? new WorkflowCoordinatorClient(workflowConfig)
			: undefined;
		const memory = workflowMemory
			? new WorkflowMemoryGateway({
					client: createHindsightClient(hindsightConfig),
					config: hindsightConfig,
					store,
					machineId,
					sessionId: this.#options.getSessionId(),
					episodeId: () => this.#state?.episodeId,
					redact: this.#options.redact,
				})
			: undefined;
		if (memory) void memory.flushOutbox();
		if (coordinator) void coordinator.flush(store);
		logger.debug("Workflow integration initialized", {
			coordinator: coordinator !== undefined,
			memory: memory !== undefined,
			repoId: repository.repositoryId,
		});
		return { config: workflowConfig, machineId, store, coordinator, memory };
	}

	#leaseInput(services: WorkflowServices, state: TaskLifecycleState): WorkspaceLeaseInput {
		return {
			workspaceId: state.workspaceId,
			taskId: state.taskId,
			attemptId: state.attemptId,
			episodeId: state.episodeId,
			machineId: services.machineId,
			leaseMs: services.config.workspaceLeaseMs,
		};
	}

	#startHeartbeat(services: WorkflowServices): void {
		if (!services.coordinator || this.#heartbeatTimer || this.#closed) return;
		this.#heartbeatTimer = setInterval(() => {
			const current = this.#state;
			if (!current || isTerminalOrSuspended(current)) return;
			void services.coordinator
				?.heartbeat(current.episodeId, services.machineId)
				.then(() => {
					this.#leaseExpiresAt = Date.now() + services.config.workspaceLeaseMs;
				})
				.catch(error => {
					logger.debug("Workflow heartbeat unavailable", { error: String(error), taskId: current.taskId });
				});
		}, services.config.heartbeatIntervalMs);
		this.#heartbeatTimer.unref();
	}

	async #shareCheckpoint(
		services: WorkflowServices,
		state: TaskLifecycleState,
		reason: WorkflowSyncReason,
	): Promise<SharedCheckpoint | undefined> {
		const remote = services.config.checkpointRemote;
		const repoRoot = state.workspace.repoRoot;
		const headCommit = state.workspace.headCommit;
		if (!remote || !repoRoot || !headCommit || !checkpointReason(reason)) return undefined;
		const ref = `refs/heads/agent/${refSegment(state.taskId)}/${refSegment(state.attemptId)}`;
		try {
			const summary = await git.status.summary(repoRoot);
			const checkpointCommit =
				state.workspace.dirtyTreeHash === null
					? headCommit
					: ((await git.stash.create(repoRoot, `ZZ checkpoint ${state.checkpointId}`)) ?? headCommit);
			await git.push(repoRoot, { remote, refspec: `${checkpointCommit}:${ref}` });
			return {
				remote,
				ref,
				commit: checkpointCommit,
				unsharedLocalChanges: (summary?.untracked ?? 0) > 0,
			};
		} catch (error) {
			logger.warn("Workflow Git checkpoint could not be shared", {
				error: String(error),
				taskId: state.taskId,
				remote,
			});
			return undefined;
		}
	}

	async syncState(state: TaskLifecycleState, reason: WorkflowSyncReason): Promise<void> {
		this.#state = state;
		const services = await this.#services;
		if (!services || this.#closed) return;
		if (services.coordinator) {
			const sharedCheckpoint = await this.#shareCheckpoint(services, state, reason);
			const request = {
				taskId: state.taskId,
				repoId: state.workspace.repoId,
				machineId: services.machineId,
				sessionKey: `${services.machineId}:${state.sessionId}`,
				reason,
				state,
				sharedCheckpoint,
			};
			services.store.enqueueCoordinator({
				id: eventId(request),
				path: "/v1/tasks",
				request,
			});
			const additionalPath = additionalCoordinatorPath(state, reason);
			if (additionalPath) {
				const additionalRequest = { ...request, event: reason };
				services.store.enqueueCoordinator({
					id: eventId({ path: additionalPath, ...additionalRequest }),
					path: additionalPath,
					request: additionalRequest,
				});
			}
			try {
				await services.coordinator.flush(services.store);
			} catch (error) {
				logger.warn("Workflow coordinator unavailable; task event remains queued locally", {
					error: String(error),
					taskId: state.taskId,
					reason,
				});
			}
			if (isTerminalOrSuspended(state)) {
				try {
					await services.coordinator.releaseWorkspace(this.#leaseInput(services, state));
				} catch (error) {
					logger.debug("Workflow workspace release unavailable", { error: String(error), taskId: state.taskId });
				}
				this.#leaseExpiresAt = 0;
			} else {
				this.#startHeartbeat(services);
			}
		}
	}

	async syncOperation(state: TaskLifecycleState, operation: TaskOperation, reason: WorkflowSyncReason): Promise<void> {
		this.#state = state;
		const services = await this.#services;
		if (!services?.coordinator || this.#closed) return;
		const request = {
			taskId: state.taskId,
			machineId: services.machineId,
			reason,
			operation,
		};
		services.store.enqueueCoordinator({
			id: eventId(request),
			path: "/v1/events",
			request,
		});
		try {
			await services.coordinator.flush(services.store);
		} catch (error) {
			logger.warn("Workflow operation event remains queued locally", {
				error: String(error),
				operationId: operation.id,
			});
		}
	}

	async assertMutationLease(state: TaskLifecycleState): Promise<void> {
		this.#state = state;
		const services = await this.#services;
		if (!services?.coordinator || this.#closed) return;
		if (Date.now() < this.#leaseExpiresAt) return;
		try {
			await services.coordinator.acquireWorkspace(this.#leaseInput(services, state));
			this.#leaseExpiresAt = Date.now() + services.config.workspaceLeaseMs;
			this.#startHeartbeat(services);
		} catch (error) {
			if (error instanceof WorkspaceLeaseConflictError || !services.config.degradedAllowExecution) throw error;
			logger.warn("Workflow coordinator unreachable; executing in degraded local mode", {
				error: String(error),
				taskId: state.taskId,
			});
		}
	}

	async recall(state: TaskLifecycleState, stage: WorkflowRecallStage): Promise<string | undefined> {
		this.#state = state;
		const services = await this.#services;
		if (!services?.memory || this.#closed) return undefined;
		const result =
			stage === "intake"
				? await services.memory.recallForIntake({
						userId: loadHindsightConfig(this.#options.settings).userId ?? "default",
						repoId: state.workspace.repoId,
						taskDraft: state.specification.goal,
					})
				: stage === "planning"
					? await services.memory.recallForPlanning({
							repoId: state.workspace.repoId,
							taskId: state.taskId,
							goal: state.specification.goal,
							changedFiles: state.specification.scope,
						})
					: await services.memory.recallForRecovery({
							repoId: state.workspace.repoId,
							taskId: state.taskId,
							attemptId: state.attemptId,
							failure: state.pendingOperationIds.join(", ") || state.specification.goal,
						});
		return result.content;
	}

	async retainTaskMemory(memory: TaskLifecycleMemory, state: TaskLifecycleState): Promise<void> {
		this.#state = state;
		const services = await this.#services;
		if (!services?.memory || this.#closed) return;
		await services.memory.retain({
			kind: "successful-recipe",
			statement: memory.content,
			rationale: memory.context,
			applicability: {
				repoId: state.workspace.repoId,
				taskId: state.taskId,
				commitRange: state.workspace.headCommit ?? undefined,
				conditions: state.specification.constraints,
			},
			evidence: state.evidence
				.filter(item => !item.stale)
				.map(item => ({
					evidenceId: item.id,
					type:
						item.type === "acceptance"
							? ("user-confirmation" as const)
							: item.type === "verification"
								? ("test" as const)
								: item.type === "workspace"
									? ("diff" as const)
									: ("log" as const),
				})),
			confidence: "confirmed",
			documentId: `task/${state.taskId}/current-summary`,
			mutable: true,
			attemptId: state.attemptId,
			specVersion: state.specVersion,
			planVersion: state.planVersion,
			commit: state.workspace.headCommit ?? undefined,
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
		const services = await this.#services;
		if (!services) return;
		if (services.memory) await services.memory.flushOutbox();
		if (services.coordinator) {
			try {
				await services.coordinator.flush(services.store);
				if (this.#state) {
					await services.coordinator.releaseWorkspace(this.#leaseInput(services, this.#state));
				}
			} catch (error) {
				logger.debug("Workflow integration closed with queued events", { error: String(error) });
			}
		}
		services.store.close();
	}
}
