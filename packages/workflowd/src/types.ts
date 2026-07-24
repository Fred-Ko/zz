export interface WorkflowEventInput {
	idempotencyKey: string;
	taskId: string;
	path: string;
	expectedVersion: number;
	payload: Record<string, unknown>;
}

export interface WorkflowEventResult {
	version: number;
}

export interface WorkspaceLeaseInput {
	workspaceId: string;
	taskId: string;
	attemptId: string;
	episodeId: string;
	machineId: string;
	leaseMs: number;
}

export interface EpisodeHeartbeatInput {
	episodeId: string;
	machineId: string;
}

export interface WorkflowTaskRecord {
	taskId: string;
	repoId: string | null;
	phase: string | null;
	version: number;
	state: Record<string, unknown>;
	updatedAt: string;
}

export interface WorkflowRecoveryRecord {
	task: WorkflowTaskRecord;
	latestCheckpoint: Record<string, unknown> | null;
	lastEpisode: Record<string, unknown> | null;
}

export interface WorkflowRegistryStore {
	migrate(): Promise<void>;
	applyEvent(input: WorkflowEventInput): Promise<WorkflowEventResult>;
	acquireLease(input: WorkspaceLeaseInput): Promise<boolean>;
	releaseLease(input: WorkspaceLeaseInput): Promise<void>;
	heartbeat(input: EpisodeHeartbeatInput): Promise<boolean>;
	getTask(taskId: string): Promise<WorkflowTaskRecord | null>;
	getRecovery(taskId: string): Promise<WorkflowRecoveryRecord | null>;
	close(): Promise<void>;
}

export class WorkflowVersionConflictError extends Error {
	constructor(readonly currentVersion: number) {
		super(`workflow task version is ${currentVersion}`);
		this.name = "WorkflowVersionConflictError";
	}
}
