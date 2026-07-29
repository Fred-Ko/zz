export type ZZWStepExecutor = "primary" | "validator" | "subagent-readonly" | "subagent-isolated";

export type ZZWCapabilityClass = "mechanical" | "local-reasoning" | "system-reasoning";

export type ZZWDelegationDecision = "retain-primary" | "delegate-readonly" | "delegate-isolated";

export type ZZWDelegationReasonCode =
	| "cross-cutting-reasoning"
	| "shared-write-surface"
	| "unbounded-scope"
	| "exclusive-resource"
	| "high-risk-side-effect"
	| "atomic-sequence"
	| "bounded-readonly"
	| "bounded-isolated-write";

export interface ZZWDelegationAssessment {
	decision: ZZWDelegationDecision;
	reasonCode: ZZWDelegationReasonCode;
	rationale: string;
}

export type ZZWExecutionLaneRole = "implementer" | "repair" | "reviewer" | "validator";

export type ZZWPlanImpactLevel = "none" | "execution" | "structural" | "contract";

export type ZZWPlanImpactKind =
	| "none"
	| "implementation-feedback"
	| "missing-precondition"
	| "execution-failure"
	| "contradicted-precondition"
	| "contradicted-assumption"
	| "unexpected-effect"
	| "missing-step"
	| "dependency-change"
	| "resource-change"
	| "validation-change"
	| "scope-change"
	| "risk-change"
	| "contract-decision";

export interface ZZWPlanImpact {
	level: ZZWPlanImpactLevel;
	kind: ZZWPlanImpactKind;
	reason: string;
	evidence: string[];
	affectedStepIds: string[];
	contradictedAssumptionIds: string[];
	proposedChanges: string[];
}

export type ZZWResourceKind =
	| "workspace-path"
	| "git-metadata"
	| "lockfile"
	| "cache"
	| "port"
	| "service"
	| "database"
	| "external-api"
	| "cpu"
	| "memory";

export type ZZWResourceAccess = "read" | "write" | "exclusive";

export interface ZZWResourceClaim {
	kind: ZZWResourceKind;
	key: string;
	access: ZZWResourceAccess;
}

export interface ZZWWorkUnitContract {
	id: string;
	content: string;
	expectedEffects: string[];
	allowedTools: string[];
	allowedTargets: string[];
	postconditions: string[];
	resourceClaims: ZZWResourceClaim[];
	validators: string[];
	capability: ZZWCapabilityClass;
	maxRuntimeMs?: number;
}

export interface ZZWStepExecutionContract {
	executor: ZZWStepExecutor;
	delegationAssessment?: ZZWDelegationAssessment;
	resourceClaims: ZZWResourceClaim[];
	isolation: "none" | "snapshot" | "required";
	integration: "none" | "patch";
	failureDomain: "step" | "wave" | "shared-resource";
	maxRuntimeMs?: number;
	agent?: string;
	capability?: ZZWCapabilityClass;
	workUnits?: ZZWWorkUnitContract[];
}

export type ZZWExecutionWaveStatus = "prepared" | "running" | "draining" | "settled" | "interrupted" | "reconciling";

export type ZZWExecutionLaneStatus =
	| "prepared"
	| "running"
	| "succeeded"
	| "failed"
	| "cancel-requested"
	| "cancelled"
	| "interrupted"
	| "unknown"
	| "awaiting-review"
	| "awaiting-validation"
	| "awaiting-integration"
	| "awaiting-reconciliation"
	| "integrated"
	| "rejected"
	| "superseded";

export interface ZZWExecutionWave {
	id: string;
	taskId: string;
	attemptId: string;
	episodeId: string;
	specVersion: number;
	planVersion: number;
	baseWorkspaceHash: string | null;
	status: ZZWExecutionWaveStatus;
	laneIds: string[];
	admissionOpen?: boolean;
	admissionCount?: number;
	createdAt: number;
	startedAt?: number;
	settledAt?: number;
}

export interface ZZWExecutionLane {
	id: string;
	waveId: string;
	stepId: string;
	workUnitId?: string;
	role?: ZZWExecutionLaneRole;
	parentLaneId?: string;
	attempt?: number;
	stepContractHash: string;
	executor: ZZWStepExecutor;
	workspaceId: string;
	baseWorkspaceHash: string | null;
	status: ZZWExecutionLaneStatus;
	resourceClaims: ZZWResourceClaim[];
	operationIds: string[];
	artifactIds: string[];
	evidenceIds: string[];
	validators?: string[];
	candidateValidators?: string[];
	maxRuntimeMs?: number;
	capability?: ZZWCapabilityClass;
	modelSelector?: string;
	reviewerModelSelector?: string;
	repairModelSelector?: string;
	reviewerLaneId?: string;
	reviewRequired?: boolean;
	reviewVerdict?: "pass" | "reject" | "escalate";
	reviewFindings?: string[];
	residualRisks?: string[];
	planImpact?: ZZWPlanImpact;
	planImpactObservationId?: string;
	validatorLaneIds?: string[];
	repairAttempts?: number;
	maxRepairAttempts?: number;
	outputDigest?: string;
	patchPath?: string;
	branchName?: string;
	error?: string;
	createdAt: number;
	startedAt?: number;
	settledAt?: number;
}

export interface ZZWExecutionState {
	activeWaveId?: string;
	waves: ZZWExecutionWave[];
	lanes: ZZWExecutionLane[];
}

export interface ZZWExecutionSettings {
	mode: "serial" | "validation" | "safe-parallel";
	validationConcurrency: number;
	subagentConcurrency: number;
	isolationMode: "auto";
	preserveFailedLanes: boolean;
	rollingEpoch: boolean;
	workUnits: {
		enabled: boolean;
		model: string;
	};
	adversarialReview: {
		enabled: boolean;
		model: string;
		maxRepairAttempts: number;
	};
}

export const EMPTY_ZZW_EXECUTION_STATE: ZZWExecutionState = {
	waves: [],
	lanes: [],
};

export function cloneZZWResourceClaim(claim: ZZWResourceClaim): ZZWResourceClaim {
	return { ...claim };
}

export function cloneZZWPlanImpact(impact: ZZWPlanImpact | undefined): ZZWPlanImpact | undefined {
	if (!impact) return undefined;
	return {
		...impact,
		evidence: [...impact.evidence],
		affectedStepIds: [...impact.affectedStepIds],
		contradictedAssumptionIds: [...impact.contradictedAssumptionIds],
		proposedChanges: [...impact.proposedChanges],
	};
}

export function cloneZZWStepExecutionContract(contract: ZZWStepExecutionContract): ZZWStepExecutionContract {
	return {
		...contract,
		delegationAssessment: contract.delegationAssessment ? { ...contract.delegationAssessment } : undefined,
		resourceClaims: contract.resourceClaims.map(cloneZZWResourceClaim),
		workUnits: contract.workUnits?.map(workUnit => ({
			...workUnit,
			expectedEffects: [...workUnit.expectedEffects],
			allowedTools: [...workUnit.allowedTools],
			allowedTargets: [...workUnit.allowedTargets],
			postconditions: [...workUnit.postconditions],
			resourceClaims: workUnit.resourceClaims.map(cloneZZWResourceClaim),
			validators: [...workUnit.validators],
		})),
	};
}

export function cloneZZWExecutionState(state: ZZWExecutionState | undefined): ZZWExecutionState {
	if (!state) return { waves: [], lanes: [] };
	return {
		activeWaveId: state.activeWaveId,
		waves: state.waves.map(wave => ({ ...wave, laneIds: [...wave.laneIds] })),
		lanes: state.lanes.map(lane => ({
			...lane,
			resourceClaims: lane.resourceClaims.map(cloneZZWResourceClaim),
			operationIds: [...lane.operationIds],
			artifactIds: [...lane.artifactIds],
			evidenceIds: [...lane.evidenceIds],
			validators: lane.validators ? [...lane.validators] : undefined,
			candidateValidators: lane.candidateValidators ? [...lane.candidateValidators] : undefined,
			reviewFindings: lane.reviewFindings ? [...lane.reviewFindings] : undefined,
			residualRisks: lane.residualRisks ? [...lane.residualRisks] : undefined,
			planImpact: cloneZZWPlanImpact(lane.planImpact),
			validatorLaneIds: lane.validatorLaneIds ? [...lane.validatorLaneIds] : undefined,
		})),
	};
}

export function selectZZWExecutionOutcomeLanes(lanes: readonly ZZWExecutionLane[]): ZZWExecutionLane[] {
	const repairedKeys = new Set(
		lanes.filter(lane => lane.role === "repair").map(lane => `${lane.stepId}:${lane.workUnitId ?? lane.stepId}`),
	);
	const direct = lanes.filter(
		lane =>
			lane.parentLaneId === undefined &&
			(lane.role === undefined || lane.role === "implementer" || lane.role === "validator") &&
			!repairedKeys.has(`${lane.stepId}:${lane.workUnitId ?? lane.stepId}`),
	);
	const repairs = lanes
		.filter(lane => lane.role === "repair" && lane.status !== "superseded")
		.filter(lane => {
			const sameWorkUnit = lanes.filter(
				candidate =>
					candidate.stepId === lane.stepId &&
					(candidate.workUnitId ?? candidate.stepId) === (lane.workUnitId ?? lane.stepId),
			);
			return (lane.attempt ?? 0) === Math.max(...sameWorkUnit.map(candidate => candidate.attempt ?? 0));
		});
	return [...direct, ...repairs];
}
