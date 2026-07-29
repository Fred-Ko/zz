import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { TaskLifecycleState, TaskOperation } from "../goals/task-lifecycle";
import {
	createKnowledgeRuntime,
	type KnowledgeIdentity,
	type KnowledgeReviewRequest,
	type KnowledgeRuntime,
} from "../knowledge";
import sessionOrientationQueryPrompt from "../prompts/knowledge/session-orientation-query.md" with { type: "text" };
import * as git from "../utils/git";
import { loadZZWorkflowConfig, type ZZWorkflowConfig } from "./config";
import { resolveRepositoryIdentity } from "./identity";
import {
	type LocalWorkspaceLeaseInput,
	openRepositoryZZWorkflowStore,
	WorkspaceLeaseConflictError,
	type ZZWorkflowStore,
} from "./store";

export type ZZWorkflowSyncReason =
	| "created"
	| "replaced"
	| "revised"
	| "episode-started"
	| "plan-updated"
	| "execution-updated"
	| "operation-prepared"
	| "operation-running"
	| "operation-settled"
	| "operation-reconciled"
	| "paused"
	| "handoff"
	| "completed"
	| "abandoned";

export type ZZWorkflowRecallStage = "intake" | "planning" | "recovery";

export interface ZZWorkflowIntegrationOptions {
	settings: Settings;
	knowledgeEnabled: boolean;
	getCwd(): string;
	getSessionId(): string;
	redact?(content: string): string;
}

interface ZZWorkflowServices {
	config: ZZWorkflowConfig;
	store: ZZWorkflowStore;
	knowledge: KnowledgeRuntime;
	repoId: string;
}

interface LocalCheckpoint {
	commit: string;
	untrackedChanges: boolean;
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

function checkpointReason(reason: ZZWorkflowSyncReason): boolean {
	return reason === "plan-updated" || reason === "paused" || reason === "handoff" || reason === "completed";
}

export class ZZWorkflowIntegration {
	readonly #options: ZZWorkflowIntegrationOptions;
	#services: Promise<ZZWorkflowServices>;
	#state: TaskLifecycleState | undefined;
	#leaseExpiresAt = 0;
	#heartbeatTimer: Timer | undefined;
	#sessionOrientation: Promise<string | undefined> | undefined;
	#closed = false;

	constructor(options: ZZWorkflowIntegrationOptions) {
		this.#options = options;
		this.#services = this.#initialize();
		if (options.knowledgeEnabled) {
			void this.getSessionKnowledgeContext().catch(error => {
				logger.debug("ZZ knowledge session orientation unavailable", { error: String(error) });
			});
		}
	}

	async #initialize(): Promise<ZZWorkflowServices> {
		const repository = await resolveRepositoryIdentity(this.#options.getCwd());
		return this.#openServices(repository.repositoryId, repository.displayName, repository.source);
	}

	async #openServices(
		repositoryId: string,
		displayName: string,
		source: "project-config" | "canonical-remote" | "local-path",
	): Promise<ZZWorkflowServices> {
		const workflowConfig = loadZZWorkflowConfig(this.#options.settings);
		const opened = openRepositoryZZWorkflowStore(repositoryId, this.#options.settings.getAgentDir());
		const store = opened.store;
		const knowledge = createKnowledgeRuntime({
			settings: this.#options.settings,
			agentDir: this.#options.settings.getAgentDir(),
			repoId: repositoryId,
			repositoryDisplayName: displayName,
			repositoryNameSource:
				source === "canonical-remote" ? "remote" : source === "local-path" ? "local-directory" : "project-config",
			enabled: this.#options.knowledgeEnabled,
			redact: this.#options.redact,
		});
		logger.debug("Local ZZWorkflow integration initialized", {
			databasePath: opened.databasePath,
			databaseSource: opened.source,
			knowledge: (await knowledge.status()).enabled,
			migration: opened.migration,
			repoId: repositoryId,
		});
		return { config: workflowConfig, store, knowledge, repoId: repositoryId };
	}

	async #servicesFor(state?: TaskLifecycleState): Promise<ZZWorkflowServices> {
		const repository = await resolveRepositoryIdentity(this.#options.getCwd());
		const expectedRepoId = state?.workspace.repoId || repository.repositoryId;
		this.#services = this.#services.then(async current => {
			if (current.repoId === expectedRepoId || this.#closed) return current;
			this.#stopHeartbeat();
			if (this.#state) current.store.releaseLease(this.#leaseInput(current, this.#state));
			await current.knowledge.close();
			current.store.close();
			this.#leaseExpiresAt = 0;
			this.#sessionOrientation = undefined;
			const displayName = repository.repositoryId === expectedRepoId ? repository.displayName : expectedRepoId;
			const source = repository.repositoryId === expectedRepoId ? repository.source : "local-path";
			logger.info("Repository identity changed; rebinding local ZZWorkflow and Knowledge stores", {
				fromRepoId: current.repoId,
				toRepoId: expectedRepoId,
			});
			return this.#openServices(expectedRepoId, displayName, source);
		});
		return this.#services;
	}

	async getKnowledgeRuntime(): Promise<KnowledgeRuntime | undefined> {
		if (this.#closed) return undefined;
		return (await this.#servicesFor()).knowledge;
	}

	getSessionKnowledgeContext(): Promise<string | undefined> {
		if (this.#closed) return Promise.resolve(undefined);
		if (this.#sessionOrientation) return this.#sessionOrientation;
		this.#sessionOrientation = this.#loadSessionKnowledgeContext();
		return this.#sessionOrientation;
	}

	async #loadSessionKnowledgeContext(): Promise<string | undefined> {
		const services = await this.#servicesFor();
		if (this.#closed) return undefined;
		const result = await services.knowledge.recall({
			purpose: "session-orientation",
			query: sessionOrientationQueryPrompt.trim(),
			scope: { global: true, repo: true },
			depth: "normal",
			identity: {
				repoId: services.repoId,
				sessionId: this.#options.getSessionId(),
			},
		});
		return result.content;
	}

	#knowledgeIdentity(state: TaskLifecycleState): KnowledgeIdentity {
		return {
			repoId: state.workspace.repoId,
			taskId: state.taskId,
			branchId: state.workspace.branch ?? undefined,
			attemptId: state.attemptId,
			sessionId: state.sessionId,
			episodeId: state.episodeId,
			commitHash: state.workspace.headCommit ?? undefined,
			specVersion: state.specVersion,
			planVersion: state.planVersion,
		};
	}

	#leaseInput(services: ZZWorkflowServices, state: TaskLifecycleState): LocalWorkspaceLeaseInput {
		return {
			workspaceId: state.workspaceId,
			taskId: state.taskId,
			attemptId: state.attemptId,
			episodeId: state.episodeId,
			leaseMs: services.config.workspaceLeaseMs,
		};
	}

	#startHeartbeat(services: ZZWorkflowServices): void {
		if (this.#heartbeatTimer || this.#closed) return;
		this.#heartbeatTimer = setInterval(() => {
			const current = this.#state;
			if (!current || isTerminalOrSuspended(current)) return;
			try {
				if (!services.store.heartbeat(current.episodeId)) {
					this.#leaseExpiresAt = 0;
					this.#stopHeartbeat();
					logger.warn("Local ZZWorkflow lease heartbeat stopped because ownership was lost", {
						taskId: current.taskId,
					});
					return;
				}
				this.#leaseExpiresAt = Date.now() + services.config.workspaceLeaseMs;
			} catch (error) {
				logger.warn("Local ZZWorkflow heartbeat failed", { error: String(error), taskId: current.taskId });
			}
		}, services.config.heartbeatIntervalMs);
		this.#heartbeatTimer.unref();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
	}

	async #captureCheckpoint(
		state: TaskLifecycleState,
		reason: ZZWorkflowSyncReason,
	): Promise<LocalCheckpoint | undefined> {
		const repoRoot = state.workspace.repoRoot;
		const headCommit = state.workspace.headCommit;
		if (!repoRoot || !headCommit || !checkpointReason(reason)) return undefined;
		try {
			const summary = await git.status.summary(repoRoot);
			const commit =
				state.workspace.dirtyTreeHash === null
					? headCommit
					: ((await git.stash.create(repoRoot, `ZZ local checkpoint ${state.checkpointId}`)) ?? headCommit);
			return {
				commit,
				untrackedChanges: (summary?.untracked ?? 0) > 0,
			};
		} catch (error) {
			logger.warn("Local ZZWorkflow Git checkpoint could not be captured", {
				error: String(error),
				taskId: state.taskId,
			});
			return undefined;
		}
	}

	async syncState(state: TaskLifecycleState, reason: ZZWorkflowSyncReason): Promise<void> {
		this.#state = state;
		const services = await this.#servicesFor(state);
		if (this.#closed) return;
		const checkpoint = await this.#captureCheckpoint(state, reason);
		const payload = { reason, state, checkpoint };
		services.store.recordEvent({
			id: eventId(payload),
			taskId: state.taskId,
			repoId: state.workspace.repoId || services.repoId,
			kind: checkpointReason(reason) ? "checkpoint" : reason,
			payload,
		});
		if (isTerminalOrSuspended(state)) {
			this.#stopHeartbeat();
			services.store.releaseLease(this.#leaseInput(services, state));
			this.#leaseExpiresAt = 0;
		}
	}

	async syncOperation(
		state: TaskLifecycleState,
		operation: TaskOperation,
		reason: ZZWorkflowSyncReason,
	): Promise<void> {
		this.#state = state;
		const services = await this.#servicesFor(state);
		if (this.#closed) return;
		const payload = { reason, state, operation };
		services.store.recordEvent({
			id: eventId(payload),
			taskId: state.taskId,
			repoId: state.workspace.repoId || services.repoId,
			kind: reason,
			payload,
		});
	}

	async assertMutationLease(state: TaskLifecycleState): Promise<void> {
		this.#state = state;
		const services = await this.#servicesFor(state);
		if (this.#closed) return;
		if (Date.now() < this.#leaseExpiresAt) return;
		if (!services.store.acquireLease(this.#leaseInput(services, state))) {
			throw new WorkspaceLeaseConflictError(state.workspaceId);
		}
		this.#leaseExpiresAt = Date.now() + services.config.workspaceLeaseMs;
		this.#startHeartbeat(services);
	}

	async recall(state: TaskLifecycleState, stage: ZZWorkflowRecallStage): Promise<string | undefined> {
		this.#state = state;
		const services = await this.#servicesFor(state);
		if (this.#closed) return undefined;
		const planning = stage !== "recovery";
		const result = await services.knowledge.recall({
			purpose: stage === "recovery" ? "task-resume" : "task-planning",
			query: [
				state.specification.goal,
				...state.specification.scope,
				...(stage === "recovery" ? state.pendingOperationIds : []),
			].join("\n"),
			scope: {
				global: stage === "intake",
				repo: true,
				task: stage !== "intake",
			},
			depth: planning ? "deep" : "forensic",
			includeSourceFacts: stage === "recovery",
			identity: this.#knowledgeIdentity(state),
		});
		return result.content;
	}

	async requestTaskKnowledgeReview(state: TaskLifecycleState): Promise<void> {
		this.#state = state;
		const services = await this.#servicesFor(state);
		if (this.#closed) return;
		const evidenceRefs = state.evidence
			.filter(item => !item.stale)
			.map(item => ({
				id: item.id,
				type:
					item.type === "acceptance"
						? ("user-confirmation" as const)
						: item.type === "verification"
							? ("test" as const)
							: item.type === "workspace"
								? ("diff" as const)
								: ("log" as const),
			}));
		const candidates: KnowledgeReviewRequest["candidates"] = state.specification.statements
			.filter(
				statement =>
					statement.type === "confirmed_requirement" ||
					statement.type === "user_preference" ||
					statement.type === "rejected_option",
			)
			.map(statement => ({
				knowledgeKey: `task/${state.taskId}/specification/${statement.id}`,
				statement: statement.statement,
				form:
					statement.type === "user_preference"
						? ("preference" as const)
						: statement.type === "rejected_option"
							? ("decision" as const)
							: ("constraint" as const),
				domain: statement.type === "user_preference" ? ("user" as const) : ("product" as const),
				source: "user" as const,
				confidence: "confirmed" as const,
				evidenceRefs,
			}));
		if (candidates.length === 0) return;
		await services.knowledge.requestReview({
			id: `review-${state.taskId}-${state.specVersion}-${state.planVersion}`,
			taskId: state.taskId,
			repoId: state.workspace.repoId,
			goal: state.specification.goal,
			candidates,
			createdAt: new Date().toISOString(),
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#stopHeartbeat();
		const services = await this.#services;
		await services.knowledge.close();
		if (this.#state) services.store.releaseLease(this.#leaseInput(services, this.#state));
		services.store.close();
	}
}
