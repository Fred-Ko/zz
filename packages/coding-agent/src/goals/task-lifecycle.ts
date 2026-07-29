import * as path from "node:path";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { escapeXmlText, isEnoent, isRecord, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import taskLifecycleContextPrompt from "../prompts/goals/task-lifecycle-context.md" with { type: "text" };
import * as git from "../utils/git";
import {
	effectiveStepExecution,
	selectExecutionWave,
	type ZZWExecutionWaveSelection,
} from "../workflow/execution/scheduler";
import {
	cloneZZWExecutionState,
	cloneZZWPlanImpact,
	cloneZZWStepExecutionContract,
	EMPTY_ZZW_EXECUTION_STATE,
	selectZZWExecutionOutcomeLanes,
	type ZZWDelegationAssessment,
	type ZZWExecutionLane,
	type ZZWExecutionSettings,
	type ZZWExecutionState,
	type ZZWExecutionWave,
	type ZZWPlanImpact,
	type ZZWStepExecutionContract,
	type ZZWWorkUnitContract,
} from "../workflow/execution/types";
import { resolveRepositoryIdentity } from "../workflow/identity";
import type { Goal } from "./state";

export const TASK_LIFECYCLE_ENTRY_TYPE = "task-lifecycle";
export const TASK_OPERATION_ENTRY_TYPE = "task-operation";
export const TASK_LIFECYCLE_SCHEMA_VERSION = 2;
const LEGACY_TASK_LIFECYCLE_SCHEMA_VERSION = 1;

export type TaskLifecyclePhase =
	| "INTAKE"
	| "DISCOVERY"
	| "SPECIFICATION"
	| "PREPARATION"
	| "READY"
	| "EXECUTING"
	| "RECONCILING"
	| "VERIFYING"
	| "REPLANNING"
	| "AWAITING_USER"
	| "PAUSING"
	| "SUSPENDED"
	| "INTERRUPTED"
	| "RECOVERING"
	| "COMPLETING"
	| "COMPLETED"
	| "ABANDONED"
	| "FAILED";

export type TaskStatementType =
	| "confirmed_requirement"
	| "provisional_requirement"
	| "assumption"
	| "open_question"
	| "rejected_option"
	| "user_preference"
	| "out_of_scope";

export interface TaskStatement {
	id: string;
	statement: string;
	type: TaskStatementType;
	sourceSessionId: string;
	confirmedAt?: number;
}

export interface TaskSuccessCriterion {
	id: string;
	description: string;
}

export interface TaskVerificationRequirement {
	id: string;
	description: string;
}

export interface TaskSpecification {
	version: number;
	goal: string;
	/** Canonical success-condition identities used by Plan mappings. */
	successCriteria?: TaskSuccessCriterion[];
	/** Legacy/readable projection retained for persisted state compatibility. */
	successConditions: string[];
	/** Canonical verification identities; executable commands live on Plan steps. */
	verificationRequirements?: TaskVerificationRequirement[];
	/** Legacy/readable projection retained for persisted state compatibility. */
	verification: string[];
	verificationExplicit: boolean;
	scope: string[];
	outOfScope: string[];
	constraints: string[];
	statements: TaskStatement[];
}

export interface TaskWorkspaceSnapshot {
	workspaceId: string;
	repoId: string;
	cwd: string;
	repoRoot: string | null;
	canonicalRemote?: string;
	branch: string | null;
	headCommit: string | null;
	dirtyTreeHash: string | null;
	dependencyLockHash: string | null;
	environmentHash: string;
	capturedAt: number;
	captureError?: string;
}

export interface TaskReadiness {
	taskContract: boolean;
	workspaceIdentified: boolean;
	baselineRecorded: boolean;
	successMeasurable: boolean;
	approvalBoundaryDefined: boolean;
	planPresent: boolean;
	checkpointPresent: boolean;
	blockers: TaskReadinessBlocker[];
	ready: boolean;
}

export type TaskReadinessBlockerCode =
	| "TASK_CONTRACT_MISSING"
	| "WORKSPACE_UNIDENTIFIED"
	| "BASELINE_MISSING"
	| "SUCCESS_NOT_MEASURABLE"
	| "APPROVAL_BOUNDARY_UNDEFINED"
	| "PLAN_MISSING"
	| "PLAN_NOT_APPROVED"
	| "CHECKPOINT_MISSING";

export interface TaskReadinessBlocker {
	code: TaskReadinessBlockerCode;
	message: string;
}

export type TaskPlanStepStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "blocked"
	| "invalidated"
	| "superseded"
	| "abandoned";
export type TaskPlanStepKind = "work" | "validation" | "acceptance" | "milestone";
export type TaskPlanChangeKind = "initial" | "patch" | "expansion" | "repair";
export type TaskPlanApprovalImpact = "structural" | "material";
export type TaskStepResultClassification =
	| "matched"
	| "implementation-feedback"
	| "missing-precondition"
	| "execution-failure"
	| "contradicted-precondition"
	| "contradicted-assumption"
	| "unexpected-effect"
	| "verification-failure"
	| "environment-changed";
export type TaskEvidenceStaleReason =
	| "step-contract-changed"
	| "dependency-invalidated"
	| "workspace-changed"
	| "spec-changed"
	| "superseded";

export interface TaskPlanStep {
	id: string;
	phase: string;
	content: string;
	status: TaskPlanStepStatus;
	dependsOn: string[];
	kind?: TaskPlanStepKind;
	expectedEffects?: string[];
	allowedTools?: string[];
	allowedTargets?: string[];
	postconditions?: string[];
	successConditionIds?: string[];
	verificationIds?: string[];
	/** Legacy Plan mapping retained while old state is rehydrated. */
	successConditions?: string[];
	validators?: string[];
	rerunPolicy?: "safe" | "guarded" | "never";
	riskClass?: "low" | "medium" | "high";
	originPlanVersion?: number;
	lastChangedPlanVersion?: number;
	contractHash?: string;
	parentStepId?: string;
	supersedes?: string[];
	supersededBy?: string[];
	assumptionIds?: string[];
	consumesArtifacts?: string[];
	producesArtifacts?: string[];
	execution?: ZZWStepExecutionContract;
}

export interface TaskPlanChange {
	planVersion: number;
	basedOnPlanVersion: number;
	kind: TaskPlanChangeKind;
	classification: "new-discovery" | Exclude<TaskStepResultClassification, "matched">;
	observationIds: string[];
	evidenceIds: string[];
	failedStepIds: string[];
	contradictedAssumptionIds: string[];
	addedStepIds: string[];
	updatedStepIds: string[];
	supersededStepIds: string[];
	invalidatedStepIds: string[];
	preservedStepIds: string[];
	approvalImpact: TaskPlanApprovalImpact;
	rationale: string;
	createdAt: number;
}

export interface TaskPlan {
	version: number;
	status: "current" | "stale";
	approval?: "draft" | "approved";
	approvedAt?: number;
	approvedBySessionId?: string;
	basedOnVersion?: number;
	approvalImpact?: TaskPlanApprovalImpact;
	changes?: TaskPlanChange[];
	steps: TaskPlanStep[];
}

export interface TaskPlanStepProposal {
	id: string;
	phase: string;
	content: string;
	kind: TaskPlanStepKind;
	dependsOn: string[];
	expectedEffects: string[];
	allowedTools: string[];
	allowedTargets: string[];
	postconditions: string[];
	successConditionIds?: string[];
	verificationIds?: string[];
	/** Legacy direct-runtime callers may still provide descriptions. */
	successConditions?: string[];
	validators: string[];
	rerunPolicy: "safe" | "guarded" | "never";
	riskClass: "low" | "medium" | "high";
	parentStepId?: string;
	supersedes?: string[];
	assumptionIds?: string[];
	consumesArtifacts?: string[];
	producesArtifacts?: string[];
	execution?: ZZWStepExecutionContract;
}

export interface TaskPlanPatch {
	basedOnPlanVersion: number;
	addSteps: TaskPlanStepProposal[];
	updateSteps: Array<Partial<TaskPlanStepProposal> & { id: string }>;
	removeStepIds: string[];
	preserveStepIds: string[];
	contradictedAssumptions: string[];
	failedStepIds: string[];
	observationIds?: string[];
	evidenceIds?: string[];
	changeKind?: Exclude<TaskPlanChangeKind, "initial">;
	rationale: string;
}

export interface TaskReconciliation {
	stepId: string;
	laneId?: string;
	operationId?: string;
	observationId?: string;
	evidenceIds: string[];
	planImpact?: ZZWPlanImpact;
	classification?: TaskStepResultClassification;
	failureFingerprint?: string;
	repeatedFailures: number;
	requiredAction:
		| "classify-result"
		| "satisfy-approved-precondition"
		| "retry-with-changed-condition"
		| "patch-plan"
		| "request-user";
	createdAt: number;
}

export interface TaskPlanPhaseInput {
	name: string;
	tasks: Array<{
		content: string;
		status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
	}>;
}

export interface TaskCheckpoint {
	id: string;
	createdAt: number;
	phase: TaskLifecyclePhase;
	planVersion: number;
	workspaceHash: string | null;
	verified: boolean;
}

export interface TaskEvidence {
	id: string;
	type: "tool_result" | "verification" | "workspace" | "acceptance";
	summary: string;
	createdAt: number;
	workspaceHash: string | null;
	stale: boolean;
	outcome?: "passed" | "failed" | "observed";
	validator?: string;
	verificationIds?: string[];
	specVersion?: number;
	planVersion?: number;
	planStepId?: string;
	operationId?: string;
	toolName?: string;
	commandFingerprint?: string;
	resultDigest?: string;
	exitCode?: number;
	trust?: "raw" | "verified" | "legacy-untrusted";
	staleReason?: TaskEvidenceStaleReason;
	stepContractHash?: string;
}

export interface TaskObservation {
	id: string;
	kind: "fact" | "hypothesis" | "contradiction" | "risk" | "workspace-change";
	statement: string;
	evidenceIds: string[];
	confidence: number;
	affects: Array<{ type: "spec" | "assumption" | "step" | "artifact" | "verification"; id: string }>;
	createdAt: number;
}

export type TaskOperationStatus =
	| "prepared"
	| "running"
	| "committed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "unknown"
	| "compensated";

export interface TaskOperation {
	id: string;
	taskId: string;
	attemptId: string;
	episodeId: string;
	waveId?: string;
	laneId?: string;
	toolCallId: string;
	toolName: string;
	tier: Exclude<ToolTier, "read">;
	target?: string;
	preStateHash: string | null;
	postStateHash?: string | null;
	intendedEffect: string;
	idempotencyKey: string;
	checkpointId: string;
	planStepId?: string;
	status: TaskOperationStatus;
	preparedAt: number;
	settledAt?: number;
	recoveryNote?: string;
	evidenceId?: string;
	evidenceKind?: "operation" | "verification";
	validator?: string;
	verificationIds?: string[];
	fingerprint?: string;
}

export interface TaskEpisode {
	id: string;
	sessionId: string;
	startedAt: number;
	endedAt?: number;
	startWorkspace: TaskWorkspaceSnapshot;
	endReason?: "paused" | "interrupted" | "completed" | "abandoned" | "failed" | "handoff";
}

export interface TaskHandoffPacket {
	taskId: string;
	attemptId: string;
	sessionId: string;
	episodeId: string;
	specVersion: number;
	planVersion: number;
	workspace: TaskWorkspaceSnapshot;
	phase: TaskLifecyclePhase;
	checkpointId: string;
	pendingOperationIds: string[];
	staleEvidenceIds: string[];
	activePlanStepId?: string;
	plan: TaskPlan;
	nextSafeAction: string;
}

export interface TaskLifecycleState {
	schemaVersion: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
	taskId: string;
	specVersion: number;
	attemptId: string;
	sessionId: string;
	episodeId: string;
	workspaceId: string;
	planVersion: number;
	checkpointId: string;
	phase: TaskLifecyclePhase;
	specification: TaskSpecification;
	workspace: TaskWorkspaceSnapshot;
	readiness: TaskReadiness;
	plan: TaskPlan;
	checkpoint: TaskCheckpoint;
	episode: TaskEpisode;
	evidence: TaskEvidence[];
	observations?: TaskObservation[];
	execution: ZZWExecutionState;
	pendingOperationIds: string[];
	stalePlan: boolean;
	reconciliation?: TaskReconciliation;
	createdAt: number;
	updatedAt: number;
	handoff?: TaskHandoffPacket;
}

export interface TaskLifecycleSummary {
	taskId: string;
	attemptId: string;
	sessionId: string;
	episodeId: string;
	workspaceId: string;
	specVersion: number;
	planVersion: number;
	checkpointId: string;
	phase: TaskLifecyclePhase;
	pendingOperationIds: string[];
	stalePlan: boolean;
	activePlanStepId?: string;
	activePlanStepIds: string[];
	readyPlanStepIds: string[];
	activeWaveId?: string;
	delegatedStepIds: string[];
	retainedPrimaryStepIds: string[];
	unassessedDelegationStepIds: string[];
	declaredWorkUnitCount: number;
	readinessReady: boolean;
	readinessBlockers: TaskReadinessBlockerCode[];
	verificationFresh: boolean;
	writesAllowed: boolean;
	requiredNextAction: string;
	workspaceHead: string | null;
}

export interface TaskExecutionWaveRequest {
	stepIds?: string[];
	mode: "serial" | "validation" | "safe-parallel";
	validationConcurrency: number;
	subagentConcurrency: number;
	rollingEpoch?: boolean;
	workUnitsEnabled?: boolean;
	workUnitModel?: string;
	adversarialReviewEnabled?: boolean;
	adversarialReviewerModel?: string;
	maxRepairAttempts?: number;
}

export interface TaskPreparedExecutionWave {
	wave: ZZWExecutionWave;
	lanes: ZZWExecutionLane[];
	deferred: ZZWExecutionWaveSelection["deferred"];
}

export interface TaskExecutionLaneResult {
	laneId: string;
	validator?: string;
	exitCode?: number;
	outputDigest?: string;
	artifactIds?: string[];
	patchPath?: string;
	branchName?: string;
	planImpact?: ZZWPlanImpact;
	error?: string;
	cancelled?: boolean;
	interrupted?: boolean;
}

export interface TaskExecutionLaneIntegrationResult {
	laneId: string;
	succeeded: boolean;
	outputDigest?: string;
	error?: string;
}

export interface TaskExecutionReviewResult {
	reviewerLaneId: string;
	verdict: "pass" | "reject" | "escalate";
	findings: string[];
	residualRisks: string[];
	planImpact: ZZWPlanImpact;
}

export interface TaskLifecycleHandoff {
	state: TaskLifecycleState;
	operations: TaskOperation[];
}

export type TaskPlanValidationIssueCode =
	| "PLAN_EMPTY"
	| "WORK_STEP_MISSING"
	| "STEP_ID_MISSING"
	| "STEP_PHASE_MISSING"
	| "STEP_CONTENT_MISSING"
	| "DUPLICATE_STEP_ID"
	| "UNKNOWN_DEPENDENCY"
	| "INACTIVE_DEPENDENCY"
	| "SELF_DEPENDENCY"
	| "DEPENDENCY_CYCLE"
	| "MILESTONE_EXECUTION_FIELDS"
	| "DELEGATION_ASSESSMENT_MISSING"
	| "DELEGATION_ASSESSMENT_INVALID"
	| "EXECUTION_CONTRACT_INVALID"
	| "RESOURCE_CLAIM_INVALID"
	| "VALIDATOR_MISSING"
	| "UNKNOWN_SUCCESS_CONDITION_ID"
	| "UNKNOWN_VERIFICATION_ID"
	| "VERIFICATION_REQUIRES_VALIDATION_STEP"
	| "UNMAPPED_SUCCESS_CONDITION"
	| "UNMAPPED_VERIFICATION";

export interface TaskPlanValidationIssue {
	code: TaskPlanValidationIssueCode;
	message: string;
	stepId?: string;
	referenceId?: string;
}

export class TaskPlanValidationError extends Error {
	readonly code = "INVALID_PLAN_MAPPING" as const;

	constructor(readonly issues: TaskPlanValidationIssue[]) {
		super(
			JSON.stringify(
				{
					accepted: false,
					code: "INVALID_PLAN_MAPPING",
					issues,
					requiredAction:
						"권위 있는 Specification ID를 다시 읽고 모든 누락을 한 번에 수정한 뒤 Plan을 한 번만 다시 제안하세요.",
				},
				null,
				2,
			),
		);
		this.name = "TaskPlanValidationError";
	}

	toDetails(): {
		accepted: false;
		code: "INVALID_PLAN_MAPPING";
		issues: TaskPlanValidationIssue[];
		requiredAction: string;
	} {
		return {
			accepted: false,
			code: this.code,
			issues: this.issues.map(issue => ({ ...issue })),
			requiredAction:
				"권위 있는 Specification ID를 다시 읽고 모든 누락을 한 번에 수정한 뒤 Plan을 한 번만 다시 제안하세요.",
		};
	}
}

export type GoalLifecycleEvent =
	| { type: "created"; goal: Goal }
	| { type: "replaced"; previousGoal: Goal; goal: Goal }
	| { type: "revised"; previousGoal: Goal; goal: Goal }
	| { type: "resumed"; goal: Goal }
	| { type: "thread_resumed"; goal: Goal; active: boolean }
	| { type: "paused"; goal: Goal; reason: "user" | "interrupted" }
	| { type: "budget_limited"; goal: Goal }
	| { type: "completed"; goal: Goal }
	| { type: "dropped"; goal: Goal };

export interface TaskLifecycleJournalEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface TaskLifecycleHost {
	getSessionId(): string;
	getCwd(): string;
	getEntries(): readonly TaskLifecycleJournalEntry[];
	appendCustomEntry(customType: string, data: unknown): string;
	ensureOnDisk(): Promise<void>;
	flush(): Promise<void>;
	captureWorkspace?(): Promise<TaskWorkspaceSnapshot>;
	syncZZWorkflowState?(
		state: TaskLifecycleState,
		reason:
			| "created"
			| "replaced"
			| "revised"
			| "episode-started"
			| "plan-updated"
			| "execution-updated"
			| "paused"
			| "handoff"
			| "completed"
			| "abandoned",
	): Promise<void>;
	syncZZWorkflowOperation?(
		state: TaskLifecycleState,
		operation: TaskOperation,
		reason: "operation-prepared" | "operation-running" | "operation-settled" | "operation-reconciled",
	): Promise<void>;
	assertMutationLease?(state: TaskLifecycleState): Promise<void>;
	recallTaskKnowledge?(
		state: TaskLifecycleState,
		stage: "intake" | "planning" | "recovery",
	): Promise<string | undefined>;
	requestTaskKnowledgeReview?(state: TaskLifecycleState): Promise<void> | void;
	publishPlanProjection?(state: TaskLifecycleState): Promise<void> | void;
	planPatchApprovalMode?(): "always" | "material";
	executionMode?(): "serial" | "validation" | "safe-parallel";
	executionSettings?(): ZZWExecutionSettings;
	now?(): number;
	mintId?(
		kind:
			| "attempt"
			| "episode"
			| "checkpoint"
			| "evidence"
			| "operation"
			| "statement"
			| "observation"
			| "wave"
			| "lane",
	): string;
}

interface LifecycleSnapshotEnvelope {
	schemaVersion: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
	kind: "snapshot";
	state: TaskLifecycleState;
}

interface OperationEnvelope {
	schemaVersion: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
	kind: "operation";
	operation: TaskOperation;
}

const TERMINAL_PHASES = new Set<TaskLifecyclePhase>(["COMPLETED", "ABANDONED", "FAILED"]);
const TERMINAL_LANE_STATUSES = new Set<ZZWExecutionLane["status"]>([
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
	"unknown",
	"integrated",
	"rejected",
	"superseded",
	"awaiting-reconciliation",
]);

const PLAN_IMPACT_RANK: Record<ZZWPlanImpact["level"], number> = {
	none: 0,
	execution: 1,
	structural: 2,
	contract: 3,
};

function strongerPlanImpact(
	current: ZZWPlanImpact | undefined,
	next: ZZWPlanImpact | undefined,
): ZZWPlanImpact | undefined {
	if (!current) return cloneZZWPlanImpact(next);
	if (!next) return cloneZZWPlanImpact(current);
	return cloneZZWPlanImpact(PLAN_IMPACT_RANK[next.level] >= PLAN_IMPACT_RANK[current.level] ? next : current);
}

function planImpactClassification(impact: ZZWPlanImpact): TaskStepResultClassification {
	if (impact.kind === "implementation-feedback") return "implementation-feedback";
	if (impact.kind === "missing-precondition") return "missing-precondition";
	if (impact.kind === "execution-failure") return "execution-failure";
	if (impact.kind === "contradicted-assumption") return "contradicted-assumption";
	if (impact.kind === "unexpected-effect" || impact.level === "contract") return "unexpected-effect";
	return "contradicted-precondition";
}

const LIFECYCLE_PHASES = new Set<string>([
	"INTAKE",
	"DISCOVERY",
	"SPECIFICATION",
	"PREPARATION",
	"READY",
	"EXECUTING",
	"RECONCILING",
	"VERIFYING",
	"REPLANNING",
	"AWAITING_USER",
	"PAUSING",
	"SUSPENDED",
	"INTERRUPTED",
	"RECOVERING",
	"COMPLETING",
	"COMPLETED",
	"ABANDONED",
	"FAILED",
]);
const OPERATION_STATUSES = new Set<string>([
	"prepared",
	"running",
	"committed",
	"failed",
	"cancelled",
	"interrupted",
	"unknown",
	"compensated",
]);
const PLAN_STEP_STATUSES = new Set<string>([
	"pending",
	"in_progress",
	"completed",
	"blocked",
	"invalidated",
	"superseded",
	"abandoned",
]);
const ZZW_STEP_EXECUTORS = new Set<string>(["primary", "validator", "subagent-readonly", "subagent-isolated"]);
const ZZW_RESOURCE_KINDS = new Set<string>([
	"workspace-path",
	"git-metadata",
	"lockfile",
	"cache",
	"port",
	"service",
	"database",
	"external-api",
	"cpu",
	"memory",
]);
const ZZW_RESOURCE_ACCESS = new Set<string>(["read", "write", "exclusive"]);
const ZZW_ISOLATION_MODES = new Set<string>(["none", "snapshot", "required"]);
const ZZW_INTEGRATION_MODES = new Set<string>(["none", "patch"]);
const ZZW_FAILURE_DOMAINS = new Set<string>(["step", "wave", "shared-resource"]);
const ZZW_CAPABILITY_CLASSES = new Set<string>(["mechanical", "local-reasoning", "system-reasoning"]);
const ZZW_DELEGATION_DECISIONS = new Set<string>(["retain-primary", "delegate-readonly", "delegate-isolated"]);
const ZZW_DELEGATION_REASON_CODES = new Set<string>([
	"cross-cutting-reasoning",
	"shared-write-surface",
	"unbounded-scope",
	"exclusive-resource",
	"high-risk-side-effect",
	"atomic-sequence",
	"bounded-readonly",
	"bounded-isolated-write",
]);
const RETAIN_PRIMARY_REASON_CODES = new Set<string>([
	"cross-cutting-reasoning",
	"shared-write-surface",
	"unbounded-scope",
	"exclusive-resource",
	"high-risk-side-effect",
	"atomic-sequence",
]);
const DELEGATION_EXECUTOR_BY_DECISION = {
	"retain-primary": "primary",
	"delegate-readonly": "subagent-readonly",
	"delegate-isolated": "subagent-isolated",
} as const;
const DEPENDENCY_LOCK_FILES = [
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"Cargo.lock",
	"uv.lock",
	"poetry.lock",
];

function stableRequirementDefinitions<T extends TaskSuccessCriterion | TaskVerificationRequirement>(
	values: readonly string[],
	prefix: "SC" | "V",
	existing: readonly T[] | undefined,
): T[] {
	const validExisting = (existing ?? []).filter(
		(item, index, items) =>
			typeof item.id === "string" &&
			item.id.trim().length > 0 &&
			typeof item.description === "string" &&
			item.description.trim().length > 0 &&
			items.findIndex(candidate => candidate.id === item.id) === index,
	);
	if (validExisting.length > 0) return validExisting.map(item => ({ ...item }));
	return values.map((description, index) => ({ id: `${prefix}-${index + 1}`, description }) as T);
}

function successCriteriaFor(specification: TaskSpecification): TaskSuccessCriterion[] {
	return stableRequirementDefinitions(specification.successConditions, "SC", specification.successCriteria);
}

function verificationRequirementsFor(specification: TaskSpecification): TaskVerificationRequirement[] {
	return stableRequirementDefinitions(specification.verification, "V", specification.verificationRequirements);
}

function normalizeSpecification(specification: TaskSpecification): TaskSpecification {
	const successConditions = [...specification.successConditions];
	const verification = [...specification.verification];
	return {
		...specification,
		successCriteria: stableRequirementDefinitions(successConditions, "SC", specification.successCriteria),
		successConditions,
		verificationRequirements: stableRequirementDefinitions(verification, "V", specification.verificationRequirements),
		verification,
		verificationExplicit:
			specification.verificationExplicit ??
			verification.some(item => item !== "Manual user review of the stated objective"),
		scope: [...specification.scope],
		outOfScope: [...specification.outOfScope],
		constraints: [...specification.constraints],
		statements: specification.statements.map(statement => ({ ...statement })),
	};
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter(value => value.trim().length > 0))];
}

function planStepContractHash(step: TaskPlanStep): string {
	return lifecycleHash(
		JSON.stringify({
			phase: step.phase,
			content: step.content,
			kind: step.kind,
			dependsOn: step.dependsOn,
			expectedEffects: step.expectedEffects ?? [],
			allowedTools: step.allowedTools ?? [],
			allowedTargets: step.allowedTargets ?? [],
			postconditions: step.postconditions ?? [],
			successConditionIds: step.successConditionIds ?? [],
			verificationIds: step.verificationIds ?? [],
			validators: step.validators ?? [],
			rerunPolicy: step.rerunPolicy,
			riskClass: step.riskClass,
			assumptionIds: step.assumptionIds ?? [],
			consumesArtifacts: step.consumesArtifacts ?? [],
			producesArtifacts: step.producesArtifacts ?? [],
			execution: step.execution,
		}),
	);
}

function normalizePlanStepReferences(step: TaskPlanStep, specification: TaskSpecification): TaskPlanStep {
	const successCriteria = successCriteriaFor(specification);
	const verificationRequirements = verificationRequirementsFor(specification);
	const legacySuccessIds = (step.successConditions ?? []).flatMap(description =>
		successCriteria.filter(item => item.description === description).map(item => item.id),
	);
	const legacyVerificationIds = [step.content, ...(step.validators ?? [])].flatMap(description =>
		verificationRequirements.filter(item => item.description === description).map(item => item.id),
	);
	const successConditionIds = uniqueStrings([...(step.successConditionIds ?? []), ...legacySuccessIds]);
	const verificationIds = uniqueStrings([...(step.verificationIds ?? []), ...legacyVerificationIds]);
	const legacySuccessConditions = uniqueStrings([
		...(step.successConditions ?? []),
		...successConditionIds.flatMap(id =>
			successCriteria.filter(item => item.id === id).map(item => item.description),
		),
	]);
	const normalized: TaskPlanStep = {
		...step,
		dependsOn: [...step.dependsOn],
		expectedEffects: [...(step.expectedEffects ?? [])],
		allowedTools: [...(step.allowedTools ?? [])],
		allowedTargets: [...(step.allowedTargets ?? [])],
		postconditions: [...(step.postconditions ?? [])],
		successConditionIds,
		verificationIds,
		successConditions: legacySuccessConditions,
		validators: [...(step.validators ?? [])],
		supersedes: [...(step.supersedes ?? [])],
		supersededBy: [...(step.supersededBy ?? [])],
		assumptionIds: [...(step.assumptionIds ?? [])],
		consumesArtifacts: [...(step.consumesArtifacts ?? [])],
		producesArtifacts: [...(step.producesArtifacts ?? [])],
		execution: step.execution ? cloneZZWStepExecutionContract(step.execution) : undefined,
	};
	return { ...normalized, contractHash: planStepContractHash(normalized) };
}

function cloneWorkspace(workspace: TaskWorkspaceSnapshot): TaskWorkspaceSnapshot {
	return { ...workspace };
}

function cloneOperation(operation: TaskOperation): TaskOperation {
	return { ...operation, verificationIds: [...(operation.verificationIds ?? [])] };
}

function cloneState(state: TaskLifecycleState): TaskLifecycleState {
	const specification = normalizeSpecification(state.specification);
	return {
		...state,
		specification,
		workspace: cloneWorkspace(state.workspace),
		readiness: {
			...state.readiness,
			blockers: (state.readiness.blockers ?? []).map(blocker => ({ ...blocker })),
		},
		plan: {
			...state.plan,
			approval: state.plan.approval ?? "draft",
			changes: (state.plan.changes ?? []).map(change => ({
				...change,
				observationIds: [...change.observationIds],
				evidenceIds: [...change.evidenceIds],
				failedStepIds: [...change.failedStepIds],
				contradictedAssumptionIds: [...change.contradictedAssumptionIds],
				addedStepIds: [...change.addedStepIds],
				updatedStepIds: [...change.updatedStepIds],
				supersededStepIds: [...change.supersededStepIds],
				invalidatedStepIds: [...change.invalidatedStepIds],
				preservedStepIds: [...change.preservedStepIds],
			})),
			steps: state.plan.steps.map(step => normalizePlanStepReferences(step, specification)),
		},
		checkpoint: { ...state.checkpoint },
		episode: { ...state.episode, startWorkspace: cloneWorkspace(state.episode.startWorkspace) },
		evidence: state.evidence.map(item => ({
			...item,
			verificationIds: [...(item.verificationIds ?? [])],
			trust: item.trust ?? (item.type === "verification" ? "legacy-untrusted" : "raw"),
		})),
		observations: (state.observations ?? []).map(observation => ({
			...observation,
			evidenceIds: [...observation.evidenceIds],
			affects: observation.affects.map(affected => ({ ...affected })),
		})),
		execution: cloneZZWExecutionState(state.execution),
		pendingOperationIds: [...state.pendingOperationIds],
		reconciliation: state.reconciliation
			? {
					...state.reconciliation,
					evidenceIds: [...state.reconciliation.evidenceIds],
					planImpact: cloneZZWPlanImpact(state.reconciliation.planImpact),
				}
			: undefined,
		handoff: state.handoff
			? {
					...state.handoff,
					workspace: cloneWorkspace(state.handoff.workspace),
					pendingOperationIds: [...state.handoff.pendingOperationIds],
					staleEvidenceIds: [...state.handoff.staleEvidenceIds],
					plan: {
						...state.handoff.plan,
						approval: state.handoff.plan.approval ?? "draft",
						changes: (state.handoff.plan.changes ?? []).map(change => ({
							...change,
							observationIds: [...change.observationIds],
							evidenceIds: [...change.evidenceIds],
							failedStepIds: [...change.failedStepIds],
							contradictedAssumptionIds: [...change.contradictedAssumptionIds],
							addedStepIds: [...change.addedStepIds],
							updatedStepIds: [...change.updatedStepIds],
							supersededStepIds: [...change.supersededStepIds],
							invalidatedStepIds: [...change.invalidatedStepIds],
							preservedStepIds: [...change.preservedStepIds],
						})),
						steps: state.handoff.plan.steps.map(step => normalizePlanStepReferences(step, specification)),
					},
				}
			: undefined,
	};
}

function summarizeDelegation(plan: TaskPlan): {
	delegatedStepIds: string[];
	retainedPrimaryStepIds: string[];
	unassessedDelegationStepIds: string[];
	declaredWorkUnitCount: number;
} {
	const currentWorkSteps = plan.steps.filter(
		step =>
			(step.kind ?? planStepKind(step.phase, step.content)) === "work" &&
			step.status !== "superseded" &&
			step.status !== "invalidated" &&
			step.status !== "abandoned",
	);
	return {
		delegatedStepIds: currentWorkSteps
			.filter(step => step.execution?.delegationAssessment?.decision.startsWith("delegate-") === true)
			.map(step => step.id),
		retainedPrimaryStepIds: currentWorkSteps
			.filter(step => step.execution?.delegationAssessment?.decision === "retain-primary")
			.map(step => step.id),
		unassessedDelegationStepIds: currentWorkSteps
			.filter(step => step.status !== "completed" && step.execution?.delegationAssessment === undefined)
			.map(step => step.id),
		declaredWorkUnitCount: currentWorkSteps.reduce(
			(total, step) => total + (step.execution?.workUnits?.length ?? 0),
			0,
		),
	};
}

export function summarizeTaskLifecycle(
	state: TaskLifecycleState | undefined,
	executionMode: "serial" | "validation" | "safe-parallel" = "validation",
	requireDelegationAssessment = false,
): TaskLifecycleSummary | null {
	if (!state) return null;
	const activeSteps = activePlanSteps(state.plan);
	const readySteps = readyPlanSteps(state.plan);
	const delegation = summarizeDelegation(state.plan);
	return {
		taskId: state.taskId,
		attemptId: state.attemptId,
		sessionId: state.sessionId,
		episodeId: state.episodeId,
		workspaceId: state.workspaceId,
		specVersion: state.specVersion,
		planVersion: state.planVersion,
		checkpointId: state.checkpointId,
		phase: state.phase,
		pendingOperationIds: [...state.pendingOperationIds],
		stalePlan: state.stalePlan,
		activePlanStepId: activeSteps[0]?.id ?? readySteps[0]?.id,
		activePlanStepIds: activeSteps.map(step => step.id),
		readyPlanStepIds: readySteps.map(step => step.id),
		activeWaveId: state.execution.activeWaveId,
		...delegation,
		readinessReady: state.readiness.ready,
		readinessBlockers: state.readiness.blockers.map(blocker => blocker.code),
		verificationFresh: missingValidators(state).length === 0,
		writesAllowed: writesAllowed(state, requireDelegationAssessment),
		requiredNextAction: nextRequiredAction(state, executionMode, requireDelegationAssessment),
		workspaceHead: state.workspace.headCommit,
	};
}

function lifecycleHash(value: string): string {
	return Bun.hash(value).toString(16).padStart(16, "0");
}

async function dependencyLockHash(repoRoot: string): Promise<string | null> {
	for (const name of DEPENDENCY_LOCK_FILES) {
		const file = Bun.file(path.join(repoRoot, name));
		try {
			return lifecycleHash(await file.text());
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return null;
}

export async function captureTaskWorkspace(cwd: string, now: number = Date.now()): Promise<TaskWorkspaceSnapshot> {
	const resolvedCwd = path.resolve(cwd);
	const environmentHash = lifecycleHash(`${Bun.version}\0${process.platform}\0${process.arch}`);
	try {
		const repoRoot = await git.repo.root(resolvedCwd);
		if (!repoRoot) {
			const workspaceId = `workspace-${lifecycleHash(resolvedCwd)}`;
			return {
				workspaceId,
				repoId: `repo-${lifecycleHash(resolvedCwd)}`,
				cwd: resolvedCwd,
				repoRoot: null,
				branch: null,
				headCommit: null,
				dirtyTreeHash: null,
				dependencyLockHash: null,
				environmentHash,
				capturedAt: now,
			};
		}
		const [branch, headCommit, status, lockHash, repository] = await Promise.all([
			git.branch.current(repoRoot),
			git.head.sha(repoRoot),
			git.status(repoRoot, { porcelainV1: true, untrackedFiles: "all", z: true }),
			dependencyLockHash(repoRoot),
			resolveRepositoryIdentity(repoRoot),
		]);
		const workspaceId = `workspace-${lifecycleHash(repoRoot)}`;
		return {
			workspaceId,
			repoId: repository.repositoryId,
			cwd: resolvedCwd,
			repoRoot,
			canonicalRemote: repository.canonicalRemote,
			branch,
			headCommit,
			dirtyTreeHash: status.length > 0 ? lifecycleHash(status) : null,
			dependencyLockHash: lockHash,
			environmentHash,
			capturedAt: now,
		};
	} catch (error) {
		const workspaceId = `workspace-${lifecycleHash(resolvedCwd)}`;
		return {
			workspaceId,
			repoId: `repo-${lifecycleHash(resolvedCwd)}`,
			cwd: resolvedCwd,
			repoRoot: null,
			branch: null,
			headCommit: null,
			dirtyTreeHash: null,
			dependencyLockHash: null,
			environmentHash,
			capturedAt: now,
			captureError: error instanceof Error ? error.message : String(error),
		};
	}
}

function workspaceStateHash(workspace: TaskWorkspaceSnapshot): string | null {
	if (!workspace.headCommit && !workspace.dirtyTreeHash) return null;
	return lifecycleHash(
		[
			workspace.repoRoot ?? workspace.cwd,
			workspace.branch ?? "",
			workspace.headCommit ?? "",
			workspace.dirtyTreeHash ?? "",
			workspace.dependencyLockHash ?? "",
			workspace.environmentHash,
		].join("\0"),
	);
}

function sameWorkspaceState(left: TaskWorkspaceSnapshot, right: TaskWorkspaceSnapshot): boolean {
	return (
		left.workspaceId === right.workspaceId &&
		left.branch === right.branch &&
		left.headCommit === right.headCommit &&
		left.dirtyTreeHash === right.dirtyTreeHash &&
		left.dependencyLockHash === right.dependencyLockHash &&
		left.environmentHash === right.environmentHash
	);
}

function planStepId(phase: string, content: string, index: number): string {
	return `step-${lifecycleHash(`${phase}\0${content}\0${index}`)}`;
}

const VALIDATION_STEP_PATTERN = /\b(?:acceptance|check|lint|test|validation|verification|verify)\b|검증|테스트|확인/i;

function planStepKind(phase: string, content: string): TaskPlanStepKind {
	return VALIDATION_STEP_PATTERN.test(`${phase}\n${content}`) ? "validation" : "work";
}

function isValidationStep(step: TaskPlanStep): boolean {
	return step.kind ? step.kind === "validation" : planStepKind(step.phase, step.content) === "validation";
}

function planFromSpecification(specification: TaskSpecification, version: number): TaskPlan {
	const acceptanceSteps = successCriteriaFor(specification).map((criterion, index) => {
		const content = criterion.description;
		const id = planStepId("Acceptance", content, index);
		return {
			id,
			phase: "Acceptance",
			content,
			status: "pending",
			dependsOn: [],
			kind: "acceptance",
			expectedEffects: [],
			allowedTools: [],
			allowedTargets: [],
			postconditions: [content],
			successConditionIds: [criterion.id],
			verificationIds: [],
			successConditions: [content],
			validators: [],
			rerunPolicy: "safe",
			riskClass: "low",
		} satisfies TaskPlanStep;
	});
	const verificationSteps = verificationRequirementsFor(specification).map((requirement, index) => {
		const content = requirement.description;
		return {
			id: planStepId("Verification", content, acceptanceSteps.length + index),
			phase: "Verification",
			content,
			status: "pending",
			dependsOn: acceptanceSteps.map(step => step.id),
			kind: "validation",
			expectedEffects: [],
			allowedTools: ["bash"],
			allowedTargets: [],
			postconditions: [content],
			successConditionIds: [],
			verificationIds: [requirement.id],
			successConditions: [],
			// Contract prose is not necessarily executable. The model must propose
			// the actual validator command and map it to this requirement ID.
			validators: [],
			rerunPolicy: "safe",
			riskClass: "low",
		} satisfies TaskPlanStep;
	});
	const steps = [...acceptanceSteps, ...verificationSteps].map(step =>
		normalizePlanStepReferences(
			{ ...step, originPlanVersion: version, lastChangedPlanVersion: version },
			specification,
		),
	);
	return { version, status: "current", approval: "draft", steps };
}

function matchingValidator(
	toolName: string,
	args: Record<string, unknown>,
	activeStep: TaskPlanStep | undefined,
): string | undefined {
	if (toolName !== "bash" || !activeStep || !isValidationStep(activeStep)) return undefined;
	const command = typeof args.command === "string" ? args.command.trim() : undefined;
	if (!command) return undefined;
	const normalizedCommand = command.replace(/\s+/g, " ");
	const validators = activeStep.validators ?? [];
	return validators.find(validator => validator.trim().replace(/\s+/g, " ") === normalizedCommand);
}

function freshVerificationEvidence(state: TaskLifecycleState): TaskEvidence[] {
	const currentWorkspaceHash = workspaceStateHash(state.workspace);
	return state.evidence.filter(evidence => {
		if (
			evidence.type !== "verification" ||
			evidence.trust !== "verified" ||
			evidence.outcome !== "passed" ||
			evidence.stale ||
			evidence.specVersion !== state.specVersion ||
			typeof evidence.planStepId !== "string" ||
			evidence.workspaceHash !== currentWorkspaceHash
		)
			return false;
		const currentStep = state.plan.steps.find(step => step.id === evidence.planStepId);
		if (currentStep?.status !== "completed") return false;
		return (
			evidence.planVersion === state.planVersion ||
			(typeof evidence.stepContractHash === "string" && evidence.stepContractHash === currentStep.contractHash)
		);
	});
}

function missingValidators(state: TaskLifecycleState): string[] {
	const evidence = freshVerificationEvidence(state);
	if (!state.specification.verificationExplicit) {
		return evidence.length > 0 ? [] : ["A current validation step"];
	}
	return verificationRequirementsFor(state.specification)
		.filter(
			requirement =>
				!evidence.some(
					item =>
						item.verificationIds?.includes(requirement.id) === true ||
						// Persisted legacy evidence used the requirement prose itself as the validator.
						item.validator === requirement.description,
				),
		)
		.map(requirement => `${requirement.id}: ${requirement.description}`);
}

function isApprovedPreconditionRecovery(state: TaskLifecycleState): boolean {
	return (
		state.reconciliation?.requiredAction === "satisfy-approved-precondition" &&
		state.reconciliation.classification === "missing-precondition" &&
		!state.stalePlan &&
		state.plan.status === "current" &&
		state.plan.approval === "approved"
	);
}

function nextRequiredAction(
	state: TaskLifecycleState,
	executionMode: "serial" | "validation" | "safe-parallel" = "validation",
	requireDelegationAssessment = false,
): string {
	if (state.pendingOperationIds.length > 0) return "reconcile_pending_operation";
	if (state.execution.activeWaveId) return "wait_execution_wave";
	if (isApprovedPreconditionRecovery(state)) return "satisfy_approved_precondition";
	if (state.reconciliation || state.phase === "RECONCILING") return "classify_observation_and_reconcile_plan";
	if (state.stalePlan || state.phase === "RECOVERING" || state.phase === "REPLANNING") {
		return "reconcile_workspace_and_update_plan";
	}
	if (state.plan.approval !== "approved") {
		return state.plan.steps.some(step => step.kind === "work")
			? "request_user_plan_approval"
			: "propose_executable_plan";
	}
	if (!state.readiness.ready) return "resolve_readiness_blockers";
	if (
		requireDelegationAssessment &&
		activePlanSteps(state.plan).length === 0 &&
		summarizeDelegation(state.plan).unassessedDelegationStepIds.length > 0
	) {
		return "assess_delegation_and_patch_plan";
	}
	const readySteps = readyPlanSteps(state.plan);
	const active = activePlanStep(state.plan);
	if (active && effectiveStepExecution(active).executor === "primary") return "execute_active_step";
	if (readySteps.some(step => effectiveStepExecution(step).executor === "primary")) {
		return "execute_active_step";
	}
	if (
		readySteps.some(step => {
			const executor = effectiveStepExecution(step).executor;
			return executor === "validator" || (executionMode !== "validation" && executor !== "primary");
		})
	) {
		return "run_execution_wave";
	}
	if (readySteps.some(step => effectiveStepExecution(step).executor !== "primary")) {
		return "enable_safe_parallel_or_patch_executor";
	}
	if (!active && readyMilestone(state.plan)) return "expand_ready_milestone";
	if (active?.kind === "validation") return "run_required_validation";
	if (!active && missingValidators(state).length === 0) return "propose_completion";
	return "execute_active_step";
}

function writesAllowed(state: TaskLifecycleState, requireDelegationAssessment = false): boolean {
	const approvedPreconditionRecovery = isApprovedPreconditionRecovery(state);
	return (
		state.readiness.ready &&
		state.plan.approval === "approved" &&
		!state.stalePlan &&
		(!state.reconciliation || approvedPreconditionRecovery) &&
		state.pendingOperationIds.length === 0 &&
		(state.phase === "READY" || state.phase === "EXECUTING" || approvedPreconditionRecovery) &&
		(!requireDelegationAssessment ||
			activePlanSteps(state.plan).length > 0 ||
			summarizeDelegation(state.plan).unassessedDelegationStepIds.length === 0)
	);
}

function sectionLines(objective: string, heading: string): string[] {
	const lines = objective.split(/\r?\n/);
	const normalizedHeading = heading.trim().toLocaleLowerCase();
	const headingIndex = lines.findIndex(line => {
		const match = /^##\s+(.+?)\s*$/.exec(line);
		return match?.[1]?.toLocaleLowerCase() === normalizedHeading;
	});
	if (headingIndex < 0) return [];
	const section: string[] = [];
	for (const line of lines.slice(headingIndex + 1)) {
		if (/^##\s+/.test(line)) break;
		section.push(line);
	}
	return section.map(line => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim()).filter(Boolean);
}

function stepDependenciesSatisfied(plan: TaskPlan, step: TaskPlanStep): boolean {
	return step.dependsOn.every(dependencyId => {
		const dependency = plan.steps.find(candidate => candidate.id === dependencyId);
		return dependency?.status === "completed";
	});
}

function activePlanStep(plan: TaskPlan): TaskPlanStep | undefined {
	return activePlanSteps(plan)[0] ?? readyPlanSteps(plan)[0];
}

function activePlanSteps(plan: TaskPlan): TaskPlanStep[] {
	return plan.steps.filter(
		step => step.kind !== "milestone" && step.status === "in_progress" && stepDependenciesSatisfied(plan, step),
	);
}

function readyPlanSteps(plan: TaskPlan): TaskPlanStep[] {
	return plan.steps.filter(
		step => step.kind !== "milestone" && step.status === "pending" && stepDependenciesSatisfied(plan, step),
	);
}

function readyMilestone(plan: TaskPlan): TaskPlanStep | undefined {
	return plan.steps.find(
		step => step.kind === "milestone" && step.status === "pending" && stepDependenciesSatisfied(plan, step),
	);
}

function unfinishedPlanSteps(plan: TaskPlan): TaskPlanStep[] {
	return plan.steps.filter(
		step => step.status !== "completed" && step.status !== "abandoned" && step.status !== "superseded",
	);
}

export function projectTaskPlanPhases(plan: TaskPlan): TaskPlanPhaseInput[] {
	const phases = new Map<string, TaskPlanPhaseInput>();
	for (const step of plan.steps) {
		const phaseName = typeof step.phase === "string" && step.phase.trim() ? step.phase : "복구 필요";
		const content =
			typeof step.content === "string" && step.content.trim()
				? step.content
				: `${typeof step.id === "string" && step.id.trim() ? step.id : "알 수 없는 단계"} · 손상된 Plan 단계`;
		let phase = phases.get(phaseName);
		if (!phase) {
			phase = { name: phaseName, tasks: [] };
			phases.set(phaseName, phase);
		}
		const status = step.status === "invalidated" || step.status === "superseded" ? "abandoned" : step.status;
		phase.tasks.push({ content, status });
	}
	return [...phases.values()];
}

function specificationFromGoal(
	goal: Goal,
	sessionId: string,
	version: number,
	mintStatementId: () => string,
): TaskSpecification {
	const structuredGoal = sectionLines(goal.objective, "Objective").join("\n");
	const successConditions = sectionLines(goal.objective, "Success criteria");
	const verification = sectionLines(goal.objective, "Verification");
	const boundaries = sectionLines(goal.objective, "Boundaries");
	const stopConditions = sectionLines(goal.objective, "Stop conditions");
	const resolvedGoal = structuredGoal || goal.objective;
	const resolvedSuccess = successConditions.length > 0 ? successConditions : [resolvedGoal];
	const resolvedVerification = verification.length > 0 ? verification : ["Manual user review of the stated objective"];
	const confirmedAt = goal.updatedAt;
	const statements: TaskStatement[] = [
		{
			id: mintStatementId(),
			statement: resolvedGoal,
			type: "confirmed_requirement",
			sourceSessionId: sessionId,
			confirmedAt,
		},
		...resolvedSuccess.map(statement => ({
			id: mintStatementId(),
			statement,
			type: "confirmed_requirement" as const,
			sourceSessionId: sessionId,
			confirmedAt,
		})),
		...boundaries.map(statement => ({
			id: mintStatementId(),
			statement,
			type: "user_preference" as const,
			sourceSessionId: sessionId,
			confirmedAt,
		})),
	];
	return {
		version,
		goal: resolvedGoal,
		successCriteria: resolvedSuccess.map((description, index) => ({ id: `SC-${index + 1}`, description })),
		successConditions: resolvedSuccess,
		verificationRequirements: resolvedVerification.map((description, index) => ({
			id: `V-${index + 1}`,
			description,
		})),
		verification: resolvedVerification,
		verificationExplicit: verification.length > 0,
		scope: boundaries,
		outOfScope: [],
		constraints: stopConditions,
		statements,
	};
}

function readinessFor(
	specification: TaskSpecification,
	workspace: TaskWorkspaceSnapshot,
	checkpoint: TaskCheckpoint,
	plan: TaskPlan,
) {
	const taskContract = specification.goal.length > 0;
	const workspaceIdentified = workspace.workspaceId.length > 0;
	const baselineRecorded = workspace.capturedAt > 0;
	const planDefinesValidation = plan.steps.some(step => isValidationStep(step) && (step.validators?.length ?? 0) > 0);
	const successMeasurable =
		specification.successConditions.length > 0 && (specification.verificationExplicit || planDefinesValidation);
	const approvalBoundaryDefined =
		specification.statements.some(
			statement => statement.type === "confirmed_requirement" && statement.confirmedAt !== undefined,
		) && !specification.statements.some(statement => statement.type === "open_question");
	const planPresent = plan.steps.length > 0;
	const checkpointPresent = checkpoint.id.length > 0;
	const blockers: TaskReadinessBlocker[] = [];
	if (!taskContract) {
		blockers.push({ code: "TASK_CONTRACT_MISSING", message: "Define a non-empty task objective." });
	}
	if (!workspaceIdentified) {
		blockers.push({ code: "WORKSPACE_UNIDENTIFIED", message: "Identify the workspace before execution." });
	}
	if (!baselineRecorded) {
		blockers.push({ code: "BASELINE_MISSING", message: "Capture a workspace baseline before execution." });
	}
	if (!successMeasurable) {
		blockers.push({
			code: "SUCCESS_NOT_MEASURABLE",
			message: "Add explicit verification to the goal or a validation step to the persisted plan.",
		});
	}
	if (!approvalBoundaryDefined) {
		blockers.push({
			code: "APPROVAL_BOUNDARY_UNDEFINED",
			message: "Resolve open questions and confirm the task requirements before execution.",
		});
	}
	if (!planPresent) {
		blockers.push({ code: "PLAN_MISSING", message: "Create a persisted execution plan." });
	}
	if (planPresent && plan.approval !== "approved") {
		blockers.push({
			code: "PLAN_NOT_APPROVED",
			message: "사용자가 현재 Plan DAG를 승인해야 실행할 수 있습니다.",
		});
	}
	if (!checkpointPresent) {
		blockers.push({ code: "CHECKPOINT_MISSING", message: "Create a baseline checkpoint." });
	}
	const readiness: TaskReadiness = {
		taskContract,
		workspaceIdentified,
		baselineRecorded,
		successMeasurable,
		approvalBoundaryDefined,
		planPresent,
		checkpointPresent,
		blockers,
		ready: blockers.length === 0,
	};
	return readiness;
}

function isZZWResourceClaim(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.kind === "string" &&
		ZZW_RESOURCE_KINDS.has(value.kind) &&
		typeof value.key === "string" &&
		typeof value.access === "string" &&
		ZZW_RESOURCE_ACCESS.has(value.access)
	);
}

function isZZWWorkUnitContract(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.content === "string" &&
		Array.isArray(value.expectedEffects) &&
		value.expectedEffects.every(item => typeof item === "string") &&
		Array.isArray(value.allowedTools) &&
		value.allowedTools.every(item => typeof item === "string") &&
		Array.isArray(value.allowedTargets) &&
		value.allowedTargets.every(item => typeof item === "string") &&
		Array.isArray(value.postconditions) &&
		value.postconditions.every(item => typeof item === "string") &&
		Array.isArray(value.resourceClaims) &&
		value.resourceClaims.every(isZZWResourceClaim) &&
		Array.isArray(value.validators) &&
		value.validators.every(item => typeof item === "string") &&
		typeof value.capability === "string" &&
		ZZW_CAPABILITY_CLASSES.has(value.capability) &&
		(value.maxRuntimeMs === undefined || typeof value.maxRuntimeMs === "number")
	);
}

function isZZWDelegationAssessment(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.decision === "string" &&
		ZZW_DELEGATION_DECISIONS.has(value.decision) &&
		typeof value.reasonCode === "string" &&
		ZZW_DELEGATION_REASON_CODES.has(value.reasonCode) &&
		typeof value.rationale === "string"
	);
}

function isZZWStepExecutionContract(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.executor === "string" &&
		ZZW_STEP_EXECUTORS.has(value.executor) &&
		(value.delegationAssessment === undefined || isZZWDelegationAssessment(value.delegationAssessment)) &&
		Array.isArray(value.resourceClaims) &&
		value.resourceClaims.every(isZZWResourceClaim) &&
		typeof value.isolation === "string" &&
		ZZW_ISOLATION_MODES.has(value.isolation) &&
		typeof value.integration === "string" &&
		ZZW_INTEGRATION_MODES.has(value.integration) &&
		typeof value.failureDomain === "string" &&
		ZZW_FAILURE_DOMAINS.has(value.failureDomain) &&
		(value.maxRuntimeMs === undefined || typeof value.maxRuntimeMs === "number") &&
		(value.agent === undefined || typeof value.agent === "string") &&
		(value.capability === undefined ||
			(typeof value.capability === "string" && ZZW_CAPABILITY_CLASSES.has(value.capability))) &&
		(value.workUnits === undefined ||
			(Array.isArray(value.workUnits) && value.workUnits.every(isZZWWorkUnitContract)))
	);
}

function isTaskPlan(value: unknown): value is TaskPlan {
	return (
		isRecord(value) &&
		typeof value.version === "number" &&
		(value.status === "current" || value.status === "stale") &&
		Array.isArray(value.steps) &&
		value.steps.every(
			step =>
				isRecord(step) &&
				typeof step.id === "string" &&
				typeof step.phase === "string" &&
				typeof step.content === "string" &&
				typeof step.status === "string" &&
				PLAN_STEP_STATUSES.has(step.status) &&
				Array.isArray(step.dependsOn) &&
				(step.successConditionIds === undefined ||
					(Array.isArray(step.successConditionIds) &&
						step.successConditionIds.every(item => typeof item === "string"))) &&
				(step.verificationIds === undefined ||
					(Array.isArray(step.verificationIds) && step.verificationIds.every(item => typeof item === "string"))) &&
				(step.execution === undefined || isZZWStepExecutionContract(step.execution)),
		)
	);
}

function migrateLegacyTaskPlan(value: unknown): unknown {
	if (!isRecord(value) || !Array.isArray(value.steps)) return value;
	const planVersion = typeof value.version === "number" ? value.version : 1;
	return {
		...value,
		basedOnVersion: typeof value.basedOnVersion === "number" ? value.basedOnVersion : undefined,
		changes: Array.isArray(value.changes) ? value.changes : [],
		steps: value.steps.map(step => {
			if (!isRecord(step)) return step;
			return {
				...step,
				originPlanVersion:
					typeof step.originPlanVersion === "number" ? step.originPlanVersion : Math.min(1, planVersion),
				lastChangedPlanVersion:
					typeof step.lastChangedPlanVersion === "number" ? step.lastChangedPlanVersion : planVersion,
				supersedes: Array.isArray(step.supersedes) ? step.supersedes : [],
				supersededBy: Array.isArray(step.supersededBy) ? step.supersededBy : [],
				assumptionIds: Array.isArray(step.assumptionIds) ? step.assumptionIds : [],
				consumesArtifacts: Array.isArray(step.consumesArtifacts) ? step.consumesArtifacts : [],
				producesArtifacts: Array.isArray(step.producesArtifacts) ? step.producesArtifacts : [],
			};
		}),
	};
}

function migrateLifecycleState(value: unknown): unknown {
	if (!isRecord(value) || value.schemaVersion !== LEGACY_TASK_LIFECYCLE_SCHEMA_VERSION) return value;
	const handoff = isRecord(value.handoff)
		? { ...value.handoff, plan: migrateLegacyTaskPlan(value.handoff.plan) }
		: value.handoff;
	return {
		...value,
		schemaVersion: TASK_LIFECYCLE_SCHEMA_VERSION,
		plan: migrateLegacyTaskPlan(value.plan),
		handoff,
		execution: cloneZZWExecutionState(EMPTY_ZZW_EXECUTION_STATE),
	};
}

function isRequirementDefinitions(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(item => isRecord(item) && typeof item.id === "string" && typeof item.description === "string"))
	);
}

function isZZWExecutionState(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.activeWaveId === undefined || typeof value.activeWaveId === "string") &&
		Array.isArray(value.waves) &&
		value.waves.every(
			wave =>
				isRecord(wave) &&
				typeof wave.id === "string" &&
				typeof wave.status === "string" &&
				Array.isArray(wave.laneIds),
		) &&
		Array.isArray(value.lanes) &&
		value.lanes.every(
			lane =>
				isRecord(lane) &&
				typeof lane.id === "string" &&
				typeof lane.waveId === "string" &&
				typeof lane.stepId === "string" &&
				typeof lane.status === "string" &&
				Array.isArray(lane.resourceClaims) &&
				lane.resourceClaims.every(isZZWResourceClaim) &&
				Array.isArray(lane.operationIds) &&
				Array.isArray(lane.artifactIds) &&
				Array.isArray(lane.evidenceIds),
		)
	);
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
	return (
		isRecord(value) &&
		value.schemaVersion === TASK_LIFECYCLE_SCHEMA_VERSION &&
		typeof value.taskId === "string" &&
		typeof value.specVersion === "number" &&
		typeof value.attemptId === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.episodeId === "string" &&
		typeof value.workspaceId === "string" &&
		typeof value.planVersion === "number" &&
		typeof value.checkpointId === "string" &&
		typeof value.phase === "string" &&
		LIFECYCLE_PHASES.has(value.phase) &&
		isRecord(value.specification) &&
		Array.isArray(value.specification.successConditions) &&
		isRequirementDefinitions(value.specification.successCriteria) &&
		Array.isArray(value.specification.verification) &&
		isRequirementDefinitions(value.specification.verificationRequirements) &&
		(value.specification.verificationExplicit === undefined ||
			typeof value.specification.verificationExplicit === "boolean") &&
		Array.isArray(value.specification.scope) &&
		Array.isArray(value.specification.outOfScope) &&
		Array.isArray(value.specification.constraints) &&
		Array.isArray(value.specification.statements) &&
		isRecord(value.workspace) &&
		isRecord(value.readiness) &&
		(value.readiness.blockers === undefined || Array.isArray(value.readiness.blockers)) &&
		isTaskPlan(value.plan) &&
		isRecord(value.checkpoint) &&
		isRecord(value.episode) &&
		isRecord(value.episode.startWorkspace) &&
		Array.isArray(value.evidence) &&
		isZZWExecutionState(value.execution) &&
		Array.isArray(value.pendingOperationIds) &&
		(value.handoff === undefined ||
			(isRecord(value.handoff) &&
				isRecord(value.handoff.workspace) &&
				isTaskPlan(value.handoff.plan) &&
				Array.isArray(value.handoff.pendingOperationIds) &&
				Array.isArray(value.handoff.staleEvidenceIds)))
	);
}

const PLAN_STEP_ARRAY_FIELDS = [
	"dependsOn",
	"expectedEffects",
	"allowedTools",
	"allowedTargets",
	"postconditions",
	"successConditionIds",
	"verificationIds",
	"successConditions",
	"validators",
	"supersedes",
	"supersededBy",
	"assumptionIds",
	"consumesArtifacts",
	"producesArtifacts",
] as const satisfies readonly (keyof TaskPlanStep)[];

function repairLegacyPartialPatchState(
	value: unknown,
	previousState: TaskLifecycleState | undefined,
): TaskLifecycleState | undefined {
	if (!previousState || !isRecord(value) || value.taskId !== previousState.taskId || !isRecord(value.plan)) {
		return undefined;
	}
	if (!Array.isArray(value.plan.steps)) return undefined;
	let repaired = false;
	const steps = value.plan.steps.map(rawStep => {
		if (!isRecord(rawStep) || typeof rawStep.id !== "string") return rawStep;
		const previousStep = previousState.plan.steps.find(step => step.id === rawStep.id);
		if (!previousStep) return rawStep;
		const missingRequiredField =
			typeof rawStep.phase !== "string" ||
			!rawStep.phase.trim() ||
			typeof rawStep.content !== "string" ||
			!rawStep.content.trim();
		if (!missingRequiredField) return rawStep;

		repaired = true;
		const merged: Record<string, unknown> = { ...previousStep, ...rawStep };
		for (const field of PLAN_STEP_ARRAY_FIELDS) {
			const rawValue = rawStep[field];
			const previousValue = previousStep[field];
			if (
				Array.isArray(rawValue) &&
				rawValue.length === 0 &&
				Array.isArray(previousValue) &&
				previousValue.length > 0
			) {
				merged[field] = [...previousValue];
			}
		}
		return merged;
	});
	if (!repaired) return undefined;
	const candidate: unknown = { ...value, plan: { ...value.plan, steps } };
	return isLifecycleState(candidate) ? cloneState(candidate) : undefined;
}

function lifecycleStateFromEntry(
	entry: TaskLifecycleJournalEntry,
	previousState?: TaskLifecycleState,
): TaskLifecycleState | undefined {
	if (entry.type !== "custom" || entry.customType !== TASK_LIFECYCLE_ENTRY_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	if (
		(entry.data.schemaVersion !== TASK_LIFECYCLE_SCHEMA_VERSION &&
			entry.data.schemaVersion !== LEGACY_TASK_LIFECYCLE_SCHEMA_VERSION) ||
		entry.data.kind !== "snapshot"
	)
		return undefined;
	const migrated = migrateLifecycleState(entry.data.state);
	if (isLifecycleState(migrated)) return cloneState(migrated);
	return repairLegacyPartialPatchState(migrated, previousState);
}

function isTaskOperation(value: unknown): value is TaskOperation {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.taskId === "string" &&
		(value.waveId === undefined || typeof value.waveId === "string") &&
		(value.laneId === undefined || typeof value.laneId === "string") &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		typeof value.status === "string" &&
		OPERATION_STATUSES.has(value.status)
	);
}

function operationFromEntry(entry: TaskLifecycleJournalEntry): TaskOperation | undefined {
	if (entry.type !== "custom" || entry.customType !== TASK_OPERATION_ENTRY_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	if (
		(entry.data.schemaVersion !== TASK_LIFECYCLE_SCHEMA_VERSION &&
			entry.data.schemaVersion !== LEGACY_TASK_LIFECYCLE_SCHEMA_VERSION) ||
		entry.data.kind !== "operation"
	)
		return undefined;
	return isTaskOperation(entry.data.operation) ? cloneOperation(entry.data.operation) : undefined;
}

function operationTarget(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "cwd"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, 512);
	}
	for (const key of ["url", "uri"]) {
		const value = args[key];
		if (typeof value !== "string" || !value.trim()) continue;
		try {
			const parsed = new URL(value);
			return `${parsed.origin}${parsed.pathname}`.slice(0, 512);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function normalizedFingerprintValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizedFingerprintValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, normalizedFingerprintValue(nested)]),
	);
}

function operationFingerprint(
	toolName: string,
	args: Record<string, unknown>,
	target: string | undefined,
	preStateHash: string | null,
): string {
	try {
		return lifecycleHash(JSON.stringify({ toolName, target, preStateHash, args: normalizedFingerprintValue(args) }));
	} catch {
		return lifecycleHash(`${toolName}\0${target ?? ""}\0${preStateHash ?? ""}`);
	}
}

function normalizePlanStep(
	step: TaskPlanStepProposal,
	specification: TaskSpecification,
	planVersion: number,
): TaskPlanStep {
	return normalizePlanStepReferences(
		{
			...step,
			status: "pending",
			originPlanVersion: planVersion,
			lastChangedPlanVersion: planVersion,
			dependsOn: [...step.dependsOn],
			expectedEffects: [...step.expectedEffects],
			allowedTools: [...step.allowedTools],
			allowedTargets: [...step.allowedTargets],
			postconditions: [...step.postconditions],
			successConditionIds: [...(step.successConditionIds ?? [])],
			verificationIds: [...(step.verificationIds ?? [])],
			successConditions: [...(step.successConditions ?? [])],
			validators: [...step.validators],
		},
		specification,
	);
}

function preservedExecutorAssessment(
	step: TaskPlanStep,
	execution: ZZWStepExecutionContract,
): ZZWDelegationAssessment | undefined {
	if (execution.executor === "subagent-readonly") {
		return {
			decision: "delegate-readonly",
			reasonCode: "bounded-readonly",
			rationale: "Work Unit 정책 도입 전에 저장된 read-only executor를 승인 시 그대로 보존한 호환성 판단입니다.",
		};
	}
	if (execution.executor === "subagent-isolated") {
		return {
			decision: "delegate-isolated",
			reasonCode: "bounded-isolated-write",
			rationale: "Work Unit 정책 도입 전에 저장된 isolated executor를 승인 시 그대로 보존한 호환성 판단입니다.",
		};
	}
	if (execution.executor !== "primary") return undefined;
	if (step.riskClass === "high") {
		return {
			decision: "retain-primary",
			reasonCode: "high-risk-side-effect",
			rationale: "기존 high-risk 단계의 Primary 실행 계약을 승인 시 보존했습니다.",
		};
	}
	if (execution.resourceClaims.some(claim => claim.access === "exclusive")) {
		return {
			decision: "retain-primary",
			reasonCode: "exclusive-resource",
			rationale: "기존 단계가 exclusive resource를 소유하므로 승인 시 Primary 실행 계약을 보존했습니다.",
		};
	}
	if ((step.allowedTargets?.length ?? 0) === 0 || step.allowedTargets?.includes(".")) {
		return {
			decision: "retain-primary",
			reasonCode: "unbounded-scope",
			rationale: "기존 단계의 대상 범위가 위임에 충분히 한정되지 않아 승인 시 Primary 실행 계약을 보존했습니다.",
		};
	}
	return {
		decision: "retain-primary",
		reasonCode: "shared-write-surface",
		rationale: "기존 단계의 실행 계약을 변경하지 않도록 승인 시 Primary 실행을 보존했습니다.",
	};
}

function normalizeLegacyDelegationAssessmentsForApproval(
	steps: readonly TaskPlanStep[],
	specification: TaskSpecification,
	required: boolean,
): TaskPlanStep[] {
	if (!required) return [...steps];
	return steps.map(step => {
		const kind = step.kind ?? planStepKind(step.phase, step.content);
		if (
			kind !== "work" ||
			step.status === "completed" ||
			step.status === "superseded" ||
			step.status === "invalidated" ||
			step.status === "abandoned" ||
			step.execution?.delegationAssessment
		) {
			return step;
		}
		const execution = effectiveStepExecution(step);
		const delegationAssessment = preservedExecutorAssessment(step, execution);
		if (!delegationAssessment) return step;
		return normalizePlanStepReferences(
			{
				...step,
				execution: { ...execution, delegationAssessment },
			},
			specification,
		);
	});
}

interface TaskPlanValidationOptions {
	requireDelegationAssessment?: boolean;
}

function validatePlanSteps(
	steps: readonly TaskPlanStep[],
	specification: TaskSpecification,
	options: TaskPlanValidationOptions = {},
): void {
	const issues: TaskPlanValidationIssue[] = [];
	const addIssue = (issue: TaskPlanValidationIssue): void => {
		if (
			issues.some(
				existing =>
					existing.code === issue.code &&
					existing.stepId === issue.stepId &&
					existing.referenceId === issue.referenceId,
			)
		)
			return;
		issues.push(issue);
	};
	if (steps.length === 0) {
		addIssue({ code: "PLAN_EMPTY", message: "Plan에는 최소 한 개의 단계가 필요합니다." });
	}
	if (
		!steps.some(
			step =>
				step.status !== "superseded" &&
				step.status !== "invalidated" &&
				step.status !== "abandoned" &&
				typeof step.phase === "string" &&
				typeof step.content === "string" &&
				(step.kind ?? planStepKind(step.phase, step.content)) === "work",
		)
	) {
		addIssue({
			code: "WORK_STEP_MISSING",
			message: "승인 가능한 Plan에는 최소 한 개의 실행 가능한 work 단계가 필요합니다.",
		});
	}
	const ids = new Set<string>();
	for (const step of steps) {
		if (typeof step.id !== "string" || !step.id.trim()) {
			addIssue({ code: "STEP_ID_MISSING", message: "모든 Plan 단계에는 안정적인 ID가 필요합니다." });
			continue;
		}
		if (typeof step.phase !== "string" || !step.phase.trim()) {
			addIssue({
				code: "STEP_PHASE_MISSING",
				message: `${step.id} 단계의 phase가 비어 있습니다.`,
				stepId: step.id,
			});
		}
		if (typeof step.content !== "string" || !step.content.trim()) {
			addIssue({
				code: "STEP_CONTENT_MISSING",
				message: `${step.id} 단계의 content가 비어 있습니다.`,
				stepId: step.id,
			});
		}
		if (ids.has(step.id)) {
			addIssue({
				code: "DUPLICATE_STEP_ID",
				message: `Plan 단계 ID가 중복되었습니다: ${step.id}`,
				stepId: step.id,
			});
		}
		ids.add(step.id);
	}
	for (const step of steps) {
		for (const dependencyId of step.dependsOn) {
			if (!ids.has(dependencyId)) {
				addIssue({
					code: "UNKNOWN_DEPENDENCY",
					message: `${step.id} 단계가 존재하지 않는 단계에 의존합니다: ${dependencyId}`,
					stepId: step.id,
					referenceId: dependencyId,
				});
			}
			if (dependencyId === step.id) {
				addIssue({
					code: "SELF_DEPENDENCY",
					message: `${step.id} 단계는 자기 자신에 의존할 수 없습니다.`,
					stepId: step.id,
				});
			}
			const dependency = steps.find(candidate => candidate.id === dependencyId);
			if (
				dependency &&
				(dependency.status === "superseded" ||
					dependency.status === "invalidated" ||
					dependency.status === "abandoned") &&
				step.status !== "superseded" &&
				step.status !== "invalidated" &&
				step.status !== "abandoned"
			) {
				addIssue({
					code: "INACTIVE_DEPENDENCY",
					message: `${step.id} 단계가 비활성 단계에 의존합니다: ${dependencyId}`,
					stepId: step.id,
					referenceId: dependencyId,
				});
			}
		}
		if (
			step.kind === "milestone" &&
			(step.execution !== undefined ||
				(step.validators?.length ?? 0) > 0 ||
				(step.successConditionIds?.length ?? 0) > 0 ||
				(step.verificationIds?.length ?? 0) > 0)
		) {
			addIssue({
				code: "MILESTONE_EXECUTION_FIELDS",
				message: `${step.id} milestone은 검증 매핑을 가질 수 없으며 후속 Plan 확장으로 대체해야 합니다. allowedTools와 allowedTargets는 확장 권한 상한으로만 사용됩니다.`,
				stepId: step.id,
			});
		}
		const stepKind = step.kind ?? planStepKind(step.phase, step.content);
		const currentWorkStep =
			stepKind === "work" &&
			step.status !== "completed" &&
			step.status !== "superseded" &&
			step.status !== "invalidated" &&
			step.status !== "abandoned";
		const delegationAssessment = step.execution?.delegationAssessment;
		if (currentWorkStep && options.requireDelegationAssessment && !delegationAssessment) {
			addIssue({
				code: "DELEGATION_ASSESSMENT_MISSING",
				message: `${step.id} 단계는 Work Unit 활성 정책에 따라 위임 또는 Primary 유지 판단을 명시해야 합니다.`,
				stepId: step.id,
			});
		}
		if (delegationAssessment) {
			const expectedExecutor = DELEGATION_EXECUTOR_BY_DECISION[delegationAssessment.decision];
			const reasonMatchesDecision =
				delegationAssessment.decision === "retain-primary"
					? RETAIN_PRIMARY_REASON_CODES.has(delegationAssessment.reasonCode)
					: delegationAssessment.decision === "delegate-readonly"
						? delegationAssessment.reasonCode === "bounded-readonly"
						: delegationAssessment.reasonCode === "bounded-isolated-write";
			if (
				step.execution?.executor !== expectedExecutor ||
				!delegationAssessment.rationale.trim() ||
				!reasonMatchesDecision
			) {
				addIssue({
					code: "DELEGATION_ASSESSMENT_INVALID",
					message: `${step.id} 단계의 위임 판단, executor, reasonCode와 근거가 서로 일치해야 합니다.`,
					stepId: step.id,
				});
			}
		}
		if (step.execution) {
			const workUnits = step.execution.workUnits ?? [];
			const workUnitIds = new Set<string>();
			if (
				step.execution.maxRuntimeMs !== undefined &&
				(!Number.isFinite(step.execution.maxRuntimeMs) || step.execution.maxRuntimeMs <= 0)
			) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 maxRuntimeMs는 0보다 큰 유한한 값이어야 합니다.`,
					stepId: step.id,
				});
			}
			if (step.execution.capability && !ZZW_CAPABILITY_CLASSES.has(step.execution.capability)) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 capability class가 유효하지 않습니다.`,
					stepId: step.id,
				});
			}
			if (
				workUnits.length > 0 &&
				step.execution.executor !== "subagent-readonly" &&
				step.execution.executor !== "subagent-isolated"
			) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 Work Unit은 subagent executor에서만 사용할 수 있습니다.`,
					stepId: step.id,
				});
			}
			for (const workUnit of workUnits) {
				if (!workUnit.id.trim() || workUnitIds.has(workUnit.id)) {
					addIssue({
						code: "EXECUTION_CONTRACT_INVALID",
						message: `${step.id}의 Work Unit ID는 비어 있지 않고 단계 안에서 고유해야 합니다: ${workUnit.id}`,
						stepId: step.id,
					});
				}
				workUnitIds.add(workUnit.id);
				if (!workUnit.content.trim() || !ZZW_CAPABILITY_CLASSES.has(workUnit.capability)) {
					addIssue({
						code: "EXECUTION_CONTRACT_INVALID",
						message: `${step.id}/${workUnit.id}의 content와 capability가 유효해야 합니다.`,
						stepId: step.id,
					});
				}
				if (
					workUnit.maxRuntimeMs !== undefined &&
					(!Number.isFinite(workUnit.maxRuntimeMs) || workUnit.maxRuntimeMs <= 0)
				) {
					addIssue({
						code: "EXECUTION_CONTRACT_INVALID",
						message: `${step.id}/${workUnit.id}의 maxRuntimeMs는 0보다 큰 유한한 값이어야 합니다.`,
						stepId: step.id,
					});
				}
				if (workUnit.resourceClaims.length === 0 || workUnit.resourceClaims.some(claim => !claim.key.trim())) {
					addIssue({
						code: "RESOURCE_CLAIM_INVALID",
						message: `${step.id}/${workUnit.id}에는 비어 있지 않은 resource claim이 필요합니다.`,
						stepId: step.id,
					});
				}
				const outsideTools = workUnit.allowedTools.filter(tool => !(step.allowedTools ?? []).includes(tool));
				const outsideTargets = workUnit.allowedTargets.filter(
					target =>
						!(step.allowedTargets ?? []).some(
							prefix =>
								prefix === "." || target === prefix || target.startsWith(`${prefix.replace(/\/$/, "")}/`),
						),
				);
				if (outsideTools.length > 0 || outsideTargets.length > 0) {
					addIssue({
						code: "EXECUTION_CONTRACT_INVALID",
						message: `${step.id}/${workUnit.id}이 상위 Step의 tool/target 승인 범위를 벗어납니다.`,
						stepId: step.id,
					});
				}
				if (
					step.execution.executor === "subagent-readonly" &&
					(workUnit.resourceClaims.some(claim => claim.access !== "read") ||
						workUnit.allowedTools.some(tool =>
							["bash", "edit", "write", "ast_edit", "eval", "github", "computer"].includes(tool),
						))
				) {
					addIssue({
						code: "EXECUTION_CONTRACT_INVALID",
						message: `${step.id}/${workUnit.id} read-only Work Unit은 read claim과 read-only tool만 사용할 수 있습니다.`,
						stepId: step.id,
					});
				}
				if (
					step.execution.executor === "subagent-isolated" &&
					(!workUnit.resourceClaims.some(
						claim =>
							claim.kind === "workspace-path" && (claim.access === "write" || claim.access === "exclusive"),
					) ||
						workUnit.allowedTargets.length === 0)
				) {
					addIssue({
						code: "RESOURCE_CLAIM_INVALID",
						message: `${step.id}/${workUnit.id} isolated Work Unit에는 target과 write/exclusive workspace claim이 필요합니다.`,
						stepId: step.id,
					});
				}
				if (
					step.execution.executor === "subagent-isolated" &&
					workUnit.capability === "mechanical" &&
					workUnit.validators.length === 0
				) {
					addIssue({
						code: "VALIDATOR_MISSING",
						message: `${step.id}/${workUnit.id} mechanical write Work Unit에는 exact validator가 필요합니다.`,
						stepId: step.id,
					});
				}
			}
			if (step.execution.resourceClaims.length === 0) {
				addIssue({
					code: "RESOURCE_CLAIM_INVALID",
					message: `${step.id} 단계의 execution 계약에는 최소 한 개의 resource claim이 필요합니다.`,
					stepId: step.id,
				});
			}
			if (step.execution.resourceClaims.some(claim => !claim.key.trim())) {
				addIssue({
					code: "RESOURCE_CLAIM_INVALID",
					message: `${step.id} 단계의 resource claim key가 비어 있습니다.`,
					stepId: step.id,
				});
			}
			if (
				step.execution.resourceClaims.some(claim => {
					if (claim.kind !== "workspace-path") return false;
					const normalized = path.posix.normalize(claim.key.replaceAll("\\", "/"));
					return normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/");
				})
			) {
				addIssue({
					code: "RESOURCE_CLAIM_INVALID",
					message: `${step.id} 단계의 workspace-path claim은 저장소 상대 경로여야 합니다.`,
					stepId: step.id,
				});
			}
			if (
				step.execution.agent !== undefined &&
				(step.execution.executor === "primary" || step.execution.executor === "validator")
			) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 agent 선택은 subagent executor에서만 사용할 수 있습니다.`,
					stepId: step.id,
				});
			}
			if (step.execution.executor === "validator" && !isValidationStep(step)) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 validator executor는 validation 단계에만 사용할 수 있습니다.`,
					stepId: step.id,
				});
			}
			if (step.execution.executor === "validator" && step.execution.integration !== "none") {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 validator executor는 integration=none이 필요합니다.`,
					stepId: step.id,
				});
			}
			if (
				step.execution.executor === "validator" &&
				step.execution.isolation === "none" &&
				step.execution.resourceClaims.some(claim => claim.access !== "read")
			) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 쓰기 가능 validator는 isolation=snapshot 또는 isolation=required가 필요합니다.`,
					stepId: step.id,
				});
			}
			if (
				step.execution.executor === "subagent-isolated" &&
				(step.execution.isolation !== "required" || step.execution.integration !== "patch")
			) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 isolated subagent는 isolation=required와 integration=patch가 필요합니다.`,
					stepId: step.id,
				});
			}
			if (
				step.execution.executor === "primary" &&
				(step.execution.isolation !== "none" || step.execution.integration !== "none")
			) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 primary executor는 isolation=none과 integration=none이 필요합니다.`,
					stepId: step.id,
				});
			}
			if (step.execution.executor === "subagent-isolated" && (step.allowedTargets?.length ?? 0) === 0) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 isolated subagent는 비어 있지 않은 allowedTargets가 필요합니다.`,
					stepId: step.id,
				});
			}
			if (
				step.execution.executor === "subagent-isolated" &&
				!step.execution.resourceClaims.some(
					claim => claim.kind === "workspace-path" && (claim.access === "write" || claim.access === "exclusive"),
				)
			) {
				addIssue({
					code: "RESOURCE_CLAIM_INVALID",
					message: `${step.id}의 isolated subagent는 write/exclusive workspace-path claim이 필요합니다.`,
					stepId: step.id,
				});
			}
			if (
				step.execution.executor === "subagent-readonly" &&
				(step.execution.isolation !== "none" ||
					step.execution.integration !== "none" ||
					step.execution.resourceClaims.some(claim => claim.access !== "read") ||
					(step.allowedTools ?? []).some(tool =>
						["bash", "edit", "write", "ast_edit", "eval", "github", "computer"].includes(tool),
					))
			) {
				addIssue({
					code: "EXECUTION_CONTRACT_INVALID",
					message: `${step.id}의 read-only subagent는 read claim과 integration=none만 사용할 수 있습니다.`,
					stepId: step.id,
				});
			}
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) {
			addIssue({
				code: "DEPENDENCY_CYCLE",
				message: `Plan 의존성 순환이 발견되었습니다: ${id}`,
				stepId: id,
			});
			return;
		}
		if (visited.has(id)) return;
		visiting.add(id);
		const step = steps.find(candidate => candidate.id === id);
		for (const dependencyId of step?.dependsOn ?? []) {
			if (ids.has(dependencyId)) visit(dependencyId);
		}
		visiting.delete(id);
		visited.add(id);
	};
	for (const step of steps) visit(step.id);

	const successCriteria = successCriteriaFor(specification);
	const verificationRequirements = verificationRequirementsFor(specification);
	const successIds = new Set(successCriteria.map(item => item.id));
	const verificationIds = new Set(verificationRequirements.map(item => item.id));
	const activeSteps = steps.filter(
		step => step.status !== "superseded" && step.status !== "invalidated" && step.status !== "abandoned",
	);
	const validationSteps = activeSteps.filter(step => isValidationStep(step));
	for (const step of activeSteps) {
		for (const conditionId of step.successConditionIds ?? []) {
			if (successIds.has(conditionId)) continue;
			addIssue({
				code: "UNKNOWN_SUCCESS_CONDITION_ID",
				message: `${step.id} 단계가 존재하지 않는 성공 조건을 참조합니다: ${conditionId}`,
				stepId: step.id,
				referenceId: conditionId,
			});
		}
		for (const verificationId of step.verificationIds ?? []) {
			if (!verificationIds.has(verificationId)) {
				addIssue({
					code: "UNKNOWN_VERIFICATION_ID",
					message: `${step.id} 단계가 존재하지 않는 검증 요구사항을 참조합니다: ${verificationId}`,
					stepId: step.id,
					referenceId: verificationId,
				});
			}
			if (!isValidationStep(step)) {
				addIssue({
					code: "VERIFICATION_REQUIRES_VALIDATION_STEP",
					message: `검증 요구사항 ${verificationId}은 validation 단계에서만 매핑할 수 있습니다.`,
					stepId: step.id,
					referenceId: verificationId,
				});
			}
		}
		if (isValidationStep(step) && (step.verificationIds?.length ?? 0) > 0 && (step.validators?.length ?? 0) === 0) {
			addIssue({
				code: "VALIDATOR_MISSING",
				message: `${step.id} 검증 단계에 실행 가능한 validator 명령이 없습니다.`,
				stepId: step.id,
			});
		}
	}
	if (validationSteps.flatMap(step => step.validators ?? []).length === 0) {
		addIssue({
			code: "VALIDATOR_MISSING",
			message: "Plan에는 최소 한 개의 실행 가능한 validator 명령이 필요합니다.",
		});
	}
	const mappedSuccessIds = new Set(
		activeSteps
			.filter(step => isValidationStep(step) || step.kind === "acceptance")
			.flatMap(step => step.successConditionIds ?? []),
	);
	for (const criterion of successCriteria) {
		if (mappedSuccessIds.has(criterion.id)) continue;
		addIssue({
			code: "UNMAPPED_SUCCESS_CONDITION",
			message: `성공 조건 ${criterion.id}이 validation 또는 acceptance 단계에 연결되지 않았습니다: ${criterion.description}`,
			referenceId: criterion.id,
		});
	}
	if (specification.verificationExplicit) {
		const mappedVerificationIds = new Set(validationSteps.flatMap(step => step.verificationIds ?? []));
		for (const requirement of verificationRequirements) {
			if (mappedVerificationIds.has(requirement.id)) continue;
			addIssue({
				code: "UNMAPPED_VERIFICATION",
				message: `검증 요구사항 ${requirement.id}이 validation 단계에 연결되지 않았습니다: ${requirement.description}`,
				referenceId: requirement.id,
			});
		}
	}
	if (issues.length > 0) throw new TaskPlanValidationError(issues);
}

function downstreamStepIds(plan: TaskPlan, rootStepId: string): Set<string> {
	const affected = new Set([rootStepId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const step of plan.steps) {
			if (affected.has(step.id) || !step.dependsOn.some(dependencyId => affected.has(dependencyId))) continue;
			affected.add(step.id);
			changed = true;
		}
	}
	return affected;
}

function setContainsAll<T>(container: ReadonlySet<T>, values: readonly T[]): boolean {
	return values.every(value => container.has(value));
}

function defaultAllowedToolsForStep(step: { kind?: TaskPlanStepKind }): string[] {
	if (step.kind === "validation") return ["bash"];
	if (step.kind === "acceptance" || step.kind === "milestone") return [];
	return ["write", "edit", "ast_edit", "bash", "eval", "github", "hub", "task"];
}

function effectiveAllowedTools(step: TaskPlanStep | TaskPlanStepProposal): string[] {
	return step.allowedTools?.length ? step.allowedTools : defaultAllowedToolsForStep(step);
}

function activeAuthorizationSteps(plan: TaskPlan): TaskPlanStep[] {
	return plan.steps.filter(
		step => step.status !== "superseded" && step.status !== "invalidated" && step.status !== "abandoned",
	);
}

function riskRank(riskClass: TaskPlanStepProposal["riskClass"] | undefined): number {
	if (riskClass === "high") return 2;
	if (riskClass === "medium") return 1;
	return 0;
}

function executionContractKey(contract: ZZWStepExecutionContract | undefined): string {
	if (!contract) return "primary-default";
	return JSON.stringify({
		...contract,
		resourceClaims: contract.resourceClaims
			.map(claim => ({ ...claim }))
			.sort((left, right) =>
				`${left.kind}:${left.key}:${left.access}`.localeCompare(`${right.kind}:${right.key}:${right.access}`),
			),
	});
}

function proposedStepExecutor(step: TaskPlanStep | TaskPlanStepProposal): ZZWStepExecutionContract["executor"] {
	return step.execution?.executor ?? (step.kind === "validation" ? "validator" : "primary");
}

function sameStringSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	const leftSet = new Set(left ?? []);
	const rightSet = new Set(right ?? []);
	return leftSet.size === rightSet.size && setContainsAll(leftSet, [...rightSet]);
}

function patchLeavesMappedStep(
	plan: TaskPlan,
	patch: TaskPlanPatch,
	removedStepId: string,
	field: "successConditionIds" | "verificationIds",
	value: string,
): boolean {
	const removedIds = new Set(patch.removeStepIds);
	const updates = new Map(patch.updateSteps.map(update => [update.id, update]));
	const retained = activeAuthorizationSteps(plan).some(step => {
		if (step.id === removedStepId || removedIds.has(step.id)) return false;
		const update = updates.get(step.id);
		return (update?.[field] ?? step[field] ?? []).includes(value);
	});
	return retained || patch.addSteps.some(step => (step[field] ?? []).includes(value));
}

function patchApprovalImpact(plan: TaskPlan, patch: TaskPlanPatch): TaskPlanApprovalImpact {
	const byId = new Map(plan.steps.map(step => [step.id, step]));
	const authorizationSteps = activeAuthorizationSteps(plan);
	if (
		patch.addSteps.some(step => {
			const boundaryIds = new Set([
				...(step.supersedes ?? []),
				...(step.parentStepId && byId.has(step.parentStepId) ? [step.parentStepId] : []),
				...patch.failedStepIds,
			]);
			const boundarySteps = [...boundaryIds].flatMap(id => {
				const boundary = byId.get(id);
				return boundary ? [boundary] : [];
			});
			const authorityEnvelope = boundarySteps.length > 0 ? boundarySteps : authorizationSteps;
			const envelopeTools = new Set(authorityEnvelope.flatMap(effectiveAllowedTools));
			const envelopeTargets = authorityEnvelope.flatMap(candidate => candidate.allowedTargets ?? []);
			const envelopeHasUnboundedTargets = authorityEnvelope.some(
				candidate => (candidate.allowedTargets?.length ?? 0) === 0,
			);
			const envelopeRisk = Math.max(0, ...authorityEnvelope.map(candidate => riskRank(candidate.riskClass)));
			const addsUnapprovedRootWork =
				step.kind === "work" &&
				!step.parentStepId &&
				(step.supersedes?.length ?? 0) === 0 &&
				patch.failedStepIds.length === 0;
			const addsToolAuthority = !setContainsAll(envelopeTools, effectiveAllowedTools(step));
			const targets = step.allowedTargets ?? [];
			const addsTargetAuthority =
				!envelopeHasUnboundedTargets &&
				(targets.length === 0 ||
					targets.some(
						target => !envelopeTargets.some(prefix => target === prefix || target.startsWith(`${prefix}/`)),
					));
			const addsRisk = riskRank(step.riskClass) > envelopeRisk;
			const executor = proposedStepExecutor(step);
			const addsExecutorAuthority =
				executor !== "primary" && !boundarySteps.some(candidate => proposedStepExecutor(candidate) === executor);
			const changesValidatorContract =
				executor === "validator" &&
				!boundarySteps.some(
					candidate =>
						proposedStepExecutor(candidate) === "validator" &&
						sameStringSet(candidate.validators, step.validators),
				);
			return (
				addsUnapprovedRootWork ||
				addsToolAuthority ||
				addsTargetAuthority ||
				addsRisk ||
				addsExecutorAuthority ||
				changesValidatorContract
			);
		}) ||
		patch.removeStepIds.some(id => {
			const step = byId.get(id);
			if (!step) return false;
			if (step.status === "completed") return true;
			const dropsSuccessMapping = (step.successConditionIds ?? []).some(
				id => !patchLeavesMappedStep(plan, patch, step.id, "successConditionIds", id),
			);
			const dropsVerificationMapping = (step.verificationIds ?? []).some(
				id => !patchLeavesMappedStep(plan, patch, step.id, "verificationIds", id),
			);
			return dropsSuccessMapping || dropsVerificationMapping;
		})
	)
		return "material";

	for (const update of patch.updateSteps) {
		const previous = byId.get(update.id);
		if (!previous) continue;
		const nextKind = update.kind ?? previous.kind ?? "work";
		const nextAllowedTools = update.allowedTools ?? previous.allowedTools;
		const nextTools = new Set(
			nextAllowedTools?.length ? nextAllowedTools : defaultAllowedToolsForStep({ kind: nextKind }),
		);
		const previousTools = new Set(effectiveAllowedTools(previous));
		const previousTargets = previous.allowedTargets ?? [];
		const nextTargets = update.allowedTargets ?? previousTargets;
		const previousValidators = new Set(previous.validators ?? []);
		const nextValidators = new Set(update.validators ?? previous.validators ?? []);
		const previousSuccess = new Set(previous.successConditionIds ?? []);
		const previousVerification = new Set(previous.verificationIds ?? []);
		if (
			(update.execution !== undefined &&
				executionContractKey(update.execution) !== executionContractKey(previous.execution)) ||
			riskRank(update.riskClass ?? previous.riskClass) > riskRank(previous.riskClass) ||
			!setContainsAll(previousTools, [...nextTools]) ||
			(update.allowedTargets !== undefined &&
				previousTargets.length > 0 &&
				(nextTargets.length === 0 ||
					nextTargets.some(
						target => !previousTargets.some(prefix => target === prefix || target.startsWith(`${prefix}/`)),
					))) ||
			(update.validators !== undefined &&
				(!setContainsAll(previousValidators, [...nextValidators]) ||
					!setContainsAll(nextValidators, [...previousValidators]))) ||
			(update.successConditionIds !== undefined &&
				!setContainsAll(new Set(update.successConditionIds), [...previousSuccess])) ||
			(update.verificationIds !== undefined &&
				!setContainsAll(new Set(update.verificationIds), [...previousVerification]))
		)
			return "material";
	}
	return "structural";
}

function planChangeClassification(
	patch: TaskPlanPatch,
): "new-discovery" | Exclude<TaskStepResultClassification, "matched"> {
	if (patch.contradictedAssumptions.length > 0) return "contradicted-assumption";
	if (patch.failedStepIds.length > 0) return "execution-failure";
	return "new-discovery";
}

function selectedWorkUnits(step: TaskPlanStep, input: TaskExecutionWaveRequest): ZZWWorkUnitContract[] {
	if (!input.workUnitsEnabled) return [];
	return (step.execution?.workUnits ?? []).map(workUnit => ({
		...workUnit,
		expectedEffects: [...workUnit.expectedEffects],
		allowedTools: [...workUnit.allowedTools],
		allowedTargets: [...workUnit.allowedTargets],
		postconditions: [...workUnit.postconditions],
		resourceClaims: workUnit.resourceClaims.map(claim => ({ ...claim })),
		validators: [...workUnit.validators],
	}));
}

interface ExecutionLaneSeed {
	validator?: string;
	workUnit?: ZZWWorkUnitContract;
}

export class TaskLifecycleRuntime {
	readonly #host: TaskLifecycleHost;
	#state: TaskLifecycleState | undefined;
	readonly #operations = new Map<string, TaskOperation>();
	readonly #operationByToolCall = new Map<string, string>();
	#knowledgeWorkingSet: string | undefined;

	constructor(host: TaskLifecycleHost) {
		this.#host = host;
		this.rehydrate();
	}

	get state(): TaskLifecycleState | undefined {
		return this.#state ? cloneState(this.#state) : undefined;
	}

	get operations(): TaskOperation[] {
		return [...this.#operations.values()].map(cloneOperation);
	}

	get readyStepIds(): string[] {
		return this.#state ? readyPlanSteps(this.#state.plan).map(step => step.id) : [];
	}

	#executionSettings(): ZZWExecutionSettings {
		return (
			this.#host.executionSettings?.() ?? {
				mode: this.#host.executionMode?.() ?? "validation",
				validationConcurrency: 4,
				subagentConcurrency: 3,
				isolationMode: "auto",
				preserveFailedLanes: true,
				rollingEpoch: true,
				workUnits: { enabled: false, model: "*" },
				adversarialReview: { enabled: true, model: "*", maxRepairAttempts: 1 },
			}
		);
	}

	#planValidationOptions(): TaskPlanValidationOptions {
		return { requireDelegationAssessment: this.#executionSettings().workUnits.enabled };
	}

	#createPreparedExecutionLanes(
		wave: ZZWExecutionWave,
		selection: ZZWExecutionWaveSelection,
		workspace: TaskWorkspaceSnapshot,
		input: TaskExecutionWaveRequest,
		now: number,
	): { lanes: ZZWExecutionLane[]; operations: TaskOperation[] } {
		if (!this.#state) throw new Error("no active controlled task");
		const baseWorkspaceHash = workspaceStateHash(workspace);
		const lanes: ZZWExecutionLane[] = [];
		const operations: TaskOperation[] = [];
		for (const selected of selection.selected) {
			const step = this.#state.plan.steps.find(candidate => candidate.id === selected.step.id);
			if (!step) continue;
			const workUnits = selectedWorkUnits(step, input);
			const seeds: ExecutionLaneSeed[] =
				selected.execution.executor === "validator"
					? (step.validators ?? []).map(validator => ({ validator }))
					: workUnits.length > 0
						? workUnits.map(workUnit => ({ workUnit }))
						: [{}];
			for (const [index, seed] of seeds.entries()) {
				const capability = seed.workUnit?.capability ?? selected.execution.capability;
				const resourceClaims = seed.workUnit?.resourceClaims ?? selected.execution.resourceClaims;
				const reviewRequired =
					selected.execution.executor === "subagent-isolated" && input.adversarialReviewEnabled === true;
				const lane: ZZWExecutionLane = {
					id: this.#mint("lane"),
					waveId: wave.id,
					stepId: step.id,
					workUnitId: seed.workUnit?.id,
					role: selected.execution.executor === "validator" ? "validator" : "implementer",
					attempt: 0,
					stepContractHash: step.contractHash ?? planStepContractHash(step),
					executor: selected.execution.executor,
					workspaceId: workspace.workspaceId,
					baseWorkspaceHash,
					status: "prepared",
					resourceClaims: resourceClaims.map(claim => ({ ...claim })),
					operationIds: [],
					artifactIds: [],
					evidenceIds: [],
					validators: seed.validator ? [seed.validator] : undefined,
					candidateValidators: seed.workUnit?.validators ? [...seed.workUnit.validators] : undefined,
					maxRuntimeMs: seed.workUnit?.maxRuntimeMs ?? selected.execution.maxRuntimeMs,
					capability,
					modelSelector: input.workUnitModel?.trim() || "*",
					reviewerModelSelector: input.adversarialReviewerModel?.trim() || "*",
					repairModelSelector: input.workUnitModel?.trim() || "*",
					reviewRequired,
					repairAttempts: 0,
					maxRepairAttempts:
						selected.execution.executor === "subagent-isolated"
							? Math.max(0, Math.min(3, Math.trunc(input.maxRepairAttempts ?? 1)))
							: 0,
					createdAt: now,
				};
				const toolCallId = `${wave.id}:${lane.id}:${index}`;
				const validator = seed.validator;
				const operation: TaskOperation = {
					id: this.#mint("operation"),
					taskId: this.#state.taskId,
					attemptId: this.#state.attemptId,
					episodeId: this.#state.episodeId,
					waveId: wave.id,
					laneId: lane.id,
					toolCallId,
					toolName: selected.execution.executor === "validator" ? "zzw-validator" : "zzw-subagent",
					tier:
						selected.execution.executor === "subagent-isolated" || selected.execution.executor === "primary"
							? "write"
							: "exec",
					target: (seed.workUnit?.allowedTargets ?? step.allowedTargets)?.join(",").slice(0, 512),
					preStateHash: baseWorkspaceHash,
					intendedEffect: `Execute lane ${lane.id} for Plan step ${step.id}${lane.workUnitId ? ` Work Unit ${lane.workUnitId}` : ""}`,
					idempotencyKey: `${this.#state.taskId}:${this.#state.attemptId}:${wave.id}:${lane.id}:${index}`,
					checkpointId: this.#state.checkpointId,
					planStepId: step.id,
					status: "prepared",
					preparedAt: now,
					evidenceKind: validator ? "verification" : "operation",
					validator,
					verificationIds: validator ? [...(step.verificationIds ?? [])] : [],
					fingerprint: operationFingerprint(
						selected.execution.executor === "validator" ? "zzw-validator" : "zzw-subagent",
						{ laneId: lane.id, stepId: step.id, workUnitId: lane.workUnitId, validator },
						step.id,
						baseWorkspaceHash,
					),
				};
				lane.operationIds.push(operation.id);
				operations.push(operation);
				this.#operations.set(operation.id, operation);
				this.#operationByToolCall.set(toolCallId, operation.id);
				this.#persistOperation(operation);
				wave.laneIds.push(lane.id);
				lanes.push(lane);
			}
			step.status = "in_progress";
		}
		return { lanes, operations };
	}

	async prepareExecutionWave(input: TaskExecutionWaveRequest): Promise<TaskPreparedExecutionWave> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) throw new Error("no active controlled task");
		this.#refreshPendingOperations();
		if (this.#state.execution.activeWaveId) {
			throw new Error(`Execution Wave ${this.#state.execution.activeWaveId}가 아직 종료되지 않았습니다.`);
		}
		if (this.#state.pendingOperationIds.length > 0) {
			throw new Error(`미해결 operation을 먼저 복구해야 합니다: ${this.#state.pendingOperationIds.join(", ")}`);
		}
		if (this.#state.plan.approval !== "approved" || !this.#state.readiness.ready) {
			throw new Error("승인되고 실행 준비가 완료된 Plan만 Execution Wave를 시작할 수 있습니다.");
		}
		if (this.#state.stalePlan || this.#state.reconciliation) {
			throw new Error("Plan 또는 workspace reconciliation을 완료한 뒤 Execution Wave를 시작하세요.");
		}
		const activePrimary = this.#state.plan.steps.find(
			step => step.status === "in_progress" && effectiveStepExecution(step).executor === "primary",
		);
		const readyPrimary = readyPlanSteps(this.#state.plan).find(
			candidate => effectiveStepExecution(candidate).executor === "primary",
		);
		const blockingPrimary = activePrimary ?? readyPrimary;
		if (blockingPrimary) {
			throw new Error(`Primary 단계 ${blockingPrimary.id}를 먼저 완료·보고한 뒤 Execution Wave를 시작하세요.`);
		}

		const workspace = await this.#captureWorkspace();
		if (!sameWorkspaceState(this.#state.workspace, workspace)) {
			throw new Error("현재 workspace가 Plan snapshot과 달라 Execution Wave를 시작할 수 없습니다.");
		}
		await this.#host.assertMutationLease?.(cloneState(this.#state));

		const selection = selectExecutionWave(this.#state.plan, {
			mode: input.mode,
			validationConcurrency: Math.max(1, Math.trunc(input.validationConcurrency)),
			subagentConcurrency: Math.max(1, Math.trunc(input.subagentConcurrency)),
			requestedStepIds: input.stepIds,
		});
		if (selection.selected.length === 0) {
			const reasons = selection.deferred.map(item => `${item.stepId}:${item.reason}`).join(", ");
			throw new Error(`실행 가능한 ZZW Lane이 없습니다.${reasons ? ` ${reasons}` : ""}`);
		}

		const now = this.#now();
		const baseWorkspaceHash = workspaceStateHash(workspace);
		const wave: ZZWExecutionWave = {
			id: this.#mint("wave"),
			taskId: this.#state.taskId,
			attemptId: this.#state.attemptId,
			episodeId: this.#state.episodeId,
			specVersion: this.#state.specVersion,
			planVersion: this.#state.planVersion,
			baseWorkspaceHash,
			status: "prepared",
			laneIds: [],
			admissionOpen: input.rollingEpoch === true,
			admissionCount: 1,
			createdAt: now,
		};
		const prepared = this.#createPreparedExecutionLanes(wave, selection, workspace, input, now);
		const { lanes } = prepared;

		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#state.execution.waves.push(wave);
		this.#state.execution.lanes.push(...lanes);
		this.#state.execution.activeWaveId = wave.id;
		this.#state.phase = lanes.every(lane => lane.executor === "validator") ? "VERIFYING" : "EXECUTING";
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		for (const operation of prepared.operations) {
			await this.#syncZZWorkflowOperation(operation, "operation-prepared");
		}
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return {
			wave: { ...wave, laneIds: [...wave.laneIds] },
			lanes: cloneZZWExecutionState({ waves: [], lanes }).lanes,
			deferred: selection.deferred.map(item => ({ ...item })),
		};
	}

	async admitExecutionWave(waveId: string, input: TaskExecutionWaveRequest): Promise<TaskPreparedExecutionWave> {
		if (!this.#state) throw new Error("no active controlled task");
		const wave = this.#state.execution.waves.find(candidate => candidate.id === waveId);
		if (!wave || this.#state.execution.activeWaveId !== waveId) {
			throw new Error(`Execution Wave ${waveId} is not active.`);
		}
		if (wave.admissionOpen !== true) throw new Error(`Execution Wave ${waveId} is not accepting new lanes.`);
		if (
			wave.specVersion !== this.#state.specVersion ||
			wave.planVersion !== this.#state.planVersion ||
			this.#state.plan.approval !== "approved"
		) {
			throw new Error(`Execution Wave ${waveId} no longer matches the approved Plan contract.`);
		}
		const workspace = await this.#captureWorkspace();
		if (workspaceStateHash(workspace) !== wave.baseWorkspaceHash) {
			throw new Error(`Execution Wave ${waveId} snapshot changed; close the epoch before admitting more lanes.`);
		}
		const activePrimary = this.#state.plan.steps.find(
			step => step.status === "in_progress" && effectiveStepExecution(step).executor === "primary",
		);
		const readyPrimary = readyPlanSteps(this.#state.plan).find(
			candidate => effectiveStepExecution(candidate).executor === "primary",
		);
		if (activePrimary || readyPrimary) {
			return {
				wave: { ...wave, laneIds: [...wave.laneIds] },
				lanes: [],
				deferred: [
					{ stepId: (activePrimary ?? readyPrimary)?.id ?? "primary", reason: "primary-workspace-exclusive" },
				],
			};
		}
		const occupied = wave.laneIds.flatMap(id => {
			const lane = this.#state?.execution.lanes.find(candidate => candidate.id === id);
			if (!lane || TERMINAL_LANE_STATUSES.has(lane.status)) return [];
			return [
				{
					stepId: lane.stepId,
					executor: lane.executor,
					resourceClaims: lane.resourceClaims.map(claim => ({ ...claim })),
					countsTowardCapacity: ["prepared", "running", "cancel-requested"].includes(lane.status),
				},
			];
		});
		const selection = selectExecutionWave(this.#state.plan, {
			mode: input.mode,
			validationConcurrency: Math.max(1, Math.trunc(input.validationConcurrency)),
			subagentConcurrency: Math.max(1, Math.trunc(input.subagentConcurrency)),
			requestedStepIds: input.stepIds,
			occupied,
		});
		if (selection.selected.length === 0) {
			return {
				wave: { ...wave, laneIds: [...wave.laneIds] },
				lanes: [],
				deferred: selection.deferred.map(item => ({ ...item })),
			};
		}
		const now = this.#now();
		const prepared = this.#createPreparedExecutionLanes(wave, selection, workspace, input, now);
		wave.admissionCount = (wave.admissionCount ?? 1) + 1;
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#state.execution.lanes.push(...prepared.lanes);
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		for (const operation of prepared.operations) {
			await this.#syncZZWorkflowOperation(operation, "operation-prepared");
		}
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return {
			wave: { ...wave, laneIds: [...wave.laneIds] },
			lanes: cloneZZWExecutionState({ waves: [], lanes: prepared.lanes }).lanes,
			deferred: selection.deferred.map(item => ({ ...item })),
		};
	}

	async closeExecutionWaveAdmission(waveId: string): Promise<ZZWExecutionWave> {
		if (!this.#state) throw new Error("no active controlled task");
		const wave = this.#state.execution.waves.find(candidate => candidate.id === waveId);
		if (!wave) throw new Error(`unknown Execution Wave: ${waveId}`);
		wave.admissionOpen = false;
		this.#updateExecutionWave(wave, this.#now());
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return { ...wave, laneIds: [...wave.laneIds] };
	}

	async markExecutionLaneRunning(laneId: string): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const lane = this.#state.execution.lanes.find(candidate => candidate.id === laneId);
		if (!lane) throw new Error(`unknown execution lane: ${laneId}`);
		if (lane.status !== "prepared") throw new Error(`lane ${laneId} is already ${lane.status}`);
		const wave = this.#state.execution.waves.find(candidate => candidate.id === lane.waveId);
		if (!wave) throw new Error(`unknown execution wave: ${lane.waveId}`);
		const now = this.#now();
		lane.status = "running";
		lane.startedAt = now;
		wave.status = "running";
		wave.startedAt ??= now;
		const operations = lane.operationIds.flatMap(id => {
			const operation = this.#operations.get(id);
			if (!operation) return [];
			operation.status = "running";
			this.#persistOperation(operation);
			return [operation];
		});
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		for (const operation of operations) await this.#syncZZWorkflowOperation(operation, "operation-running");
		await this.#syncZZWorkflowState("execution-updated");
		return cloneZZWExecutionState({ waves: [], lanes: [lane] }).lanes[0];
	}

	async settleExecutionLane(input: TaskExecutionLaneResult): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const lane = this.#state.execution.lanes.find(candidate => candidate.id === input.laneId);
		if (!lane) throw new Error(`unknown execution lane: ${input.laneId}`);
		if (lane.status !== "running" && lane.status !== "cancel-requested") {
			throw new Error(`lane ${lane.id} cannot settle from ${lane.status}`);
		}
		const operation = lane.operationIds
			.map(id => this.#operations.get(id))
			.find(candidate =>
				input.validator
					? candidate?.validator === input.validator &&
						(candidate.status === "prepared" || candidate.status === "running")
					: candidate?.status === "prepared" || candidate?.status === "running",
			);
		if (!operation) throw new Error(`lane ${lane.id} has no unsettled operation`);
		const now = this.#now();
		const workspace = await this.#captureWorkspace();
		const postStateHash = workspaceStateHash(workspace);
		const succeeded = !input.cancelled && !input.interrupted && !input.error && input.exitCode === 0;
		operation.status = input.cancelled
			? "cancelled"
			: input.interrupted
				? "interrupted"
				: succeeded
					? "committed"
					: "failed";
		operation.postStateHash = postStateHash;
		operation.settledAt = now;
		const snapshotMatches = postStateHash === lane.baseWorkspaceHash;
		const verification = operation.evidenceKind === "verification";
		const evidence: TaskEvidence = {
			id: this.#mint("evidence"),
			type: verification ? "verification" : "tool_result",
			summary: `${operation.toolName} ${succeeded ? "completed" : input.cancelled ? "cancelled" : "failed"}`,
			createdAt: now,
			workspaceHash: postStateHash,
			stale: verification && !snapshotMatches,
			staleReason: verification && !snapshotMatches ? "workspace-changed" : undefined,
			outcome: verification ? (succeeded ? "passed" : "failed") : succeeded ? "observed" : "failed",
			validator: operation.validator,
			verificationIds: [...(operation.verificationIds ?? [])],
			specVersion: this.#state.specVersion,
			planVersion: this.#state.planVersion,
			planStepId: lane.stepId,
			operationId: operation.id,
			toolName: operation.toolName,
			commandFingerprint: operation.validator ? lifecycleHash(operation.validator) : undefined,
			resultDigest: input.outputDigest,
			exitCode: input.exitCode,
			trust: verification && succeeded && snapshotMatches ? "verified" : "raw",
			stepContractHash: lane.stepContractHash,
		};
		operation.evidenceId = evidence.id;
		lane.evidenceIds.push(evidence.id);
		lane.artifactIds.push(...(input.artifactIds ?? []));
		lane.outputDigest = input.outputDigest;
		lane.patchPath = input.patchPath ?? lane.patchPath;
		lane.branchName = input.branchName ?? lane.branchName;
		lane.error = input.error ?? lane.error;
		this.#state.evidence.push(evidence);
		if (input.planImpact) this.#recordLanePlanImpact(lane, input.planImpact, [evidence.id]);
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#persistOperation(operation);

		const allOperationsSettled = lane.operationIds.every(id => {
			const candidate = this.#operations.get(id);
			return candidate && candidate.status !== "prepared" && candidate.status !== "running";
		});
		if (allOperationsSettled) {
			const operations = lane.operationIds.flatMap(id => {
				const candidate = this.#operations.get(id);
				return candidate ? [candidate] : [];
			});
			const allSucceeded = operations.every(candidate => candidate.status === "committed");
			const impactLevel = lane.planImpact?.level ?? "none";
			lane.status = input.cancelled
				? "cancelled"
				: input.interrupted
					? "interrupted"
					: impactLevel === "structural" || impactLevel === "contract"
						? "awaiting-reconciliation"
						: allSucceeded && impactLevel === "execution"
							? "rejected"
							: allSucceeded
								? lane.executor === "subagent-isolated" && (lane.patchPath || lane.branchName)
									? lane.reviewRequired && lane.reviewVerdict !== "pass"
										? "awaiting-review"
										: (lane.candidateValidators?.length ?? 0) > 0
											? "awaiting-validation"
											: "awaiting-integration"
									: "succeeded"
								: "failed";
			lane.settledAt = now;
		}

		const wave = this.#state.execution.waves.find(candidate => candidate.id === lane.waveId);
		if (wave) {
			if (lane.planImpact?.level === "structural" || lane.planImpact?.level === "contract") {
				wave.admissionOpen = false;
			}
			this.#updateExecutionWave(wave, now);
		}
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-settled");
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return cloneZZWExecutionState({ waves: [], lanes: [lane] }).lanes[0];
	}

	async prepareAdversarialReviewLane(candidateLaneId: string): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const candidate = this.#state.execution.lanes.find(lane => lane.id === candidateLaneId);
		if (candidate?.status !== "awaiting-review") {
			throw new Error(`lane ${candidateLaneId} is not awaiting adversarial review`);
		}
		const existing = candidate.reviewerLaneId
			? this.#state.execution.lanes.find(lane => lane.id === candidate.reviewerLaneId)
			: undefined;
		if (existing) return cloneZZWExecutionState({ waves: [], lanes: [existing] }).lanes[0];
		const step = this.#state.plan.steps.find(item => item.id === candidate.stepId);
		const wave = this.#state.execution.waves.find(item => item.id === candidate.waveId);
		if (!step || !wave || step.contractHash !== candidate.stepContractHash) {
			throw new Error(`lane ${candidateLaneId} no longer matches the approved Plan contract`);
		}
		const workspace = await this.#captureWorkspace();
		const now = this.#now();
		const lane: ZZWExecutionLane = {
			id: this.#mint("lane"),
			waveId: wave.id,
			stepId: candidate.stepId,
			workUnitId: candidate.workUnitId,
			role: "reviewer",
			parentLaneId: candidate.id,
			attempt: candidate.attempt ?? 0,
			stepContractHash: candidate.stepContractHash,
			executor: "subagent-readonly",
			workspaceId: workspace.workspaceId,
			baseWorkspaceHash: workspaceStateHash(workspace),
			status: "prepared",
			resourceClaims: candidate.resourceClaims.map(claim => ({ ...claim, access: "read" })),
			operationIds: [],
			artifactIds: [],
			evidenceIds: [],
			capability: "system-reasoning",
			modelSelector: candidate.reviewerModelSelector ?? "*",
			createdAt: now,
		};
		const operation: TaskOperation = {
			id: this.#mint("operation"),
			taskId: this.#state.taskId,
			attemptId: this.#state.attemptId,
			episodeId: this.#state.episodeId,
			waveId: wave.id,
			laneId: lane.id,
			toolCallId: `${wave.id}:${lane.id}:review`,
			toolName: "zzw-adversarial-review",
			tier: "exec",
			target: step.allowedTargets?.join(",").slice(0, 512),
			preStateHash: lane.baseWorkspaceHash,
			intendedEffect: `Independently review candidate Lane ${candidate.id}`,
			idempotencyKey: `${this.#state.taskId}:${this.#state.attemptId}:${wave.id}:${lane.id}:review`,
			checkpointId: this.#state.checkpointId,
			planStepId: step.id,
			status: "prepared",
			preparedAt: now,
			evidenceKind: "operation",
			fingerprint: operationFingerprint(
				"zzw-adversarial-review",
				{ candidateLaneId: candidate.id, reviewerLaneId: lane.id },
				step.id,
				lane.baseWorkspaceHash,
			),
		};
		lane.operationIds.push(operation.id);
		candidate.reviewerLaneId = lane.id;
		wave.laneIds.push(lane.id);
		wave.status = "draining";
		this.#state.execution.lanes.push(lane);
		this.#operations.set(operation.id, operation);
		this.#operationByToolCall.set(operation.toolCallId, operation.id);
		this.#persistOperation(operation);
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-prepared");
		await this.#syncZZWorkflowState("execution-updated");
		return cloneZZWExecutionState({ waves: [], lanes: [lane] }).lanes[0];
	}

	async recordAdversarialReview(input: TaskExecutionReviewResult): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const reviewer = this.#state.execution.lanes.find(lane => lane.id === input.reviewerLaneId);
		if (
			reviewer?.role !== "reviewer" ||
			!reviewer.parentLaneId ||
			(reviewer.status !== "succeeded" && reviewer.status !== "failed")
		) {
			throw new Error(`lane ${input.reviewerLaneId} is not a settled adversarial reviewer`);
		}
		const candidate = this.#state.execution.lanes.find(lane => lane.id === reviewer.parentLaneId);
		if (candidate?.status !== "awaiting-review") {
			throw new Error(`candidate lane ${reviewer.parentLaneId} is not awaiting review`);
		}
		const now = this.#now();
		const reviewImpact =
			input.verdict === "escalate" && input.planImpact.level === "none"
				? {
						level: "contract" as const,
						kind: "contract-decision" as const,
						reason: input.findings.join("\n") || "독립 리뷰가 사용자 판단이 필요한 사안을 발견했습니다.",
						evidence: [],
						affectedStepIds: [candidate.stepId],
						contradictedAssumptionIds: [],
						proposedChanges: [],
					}
				: input.planImpact;
		reviewer.reviewVerdict = input.verdict;
		reviewer.reviewFindings = [...input.findings];
		reviewer.residualRisks = [...input.residualRisks];
		this.#recordLanePlanImpact(reviewer, reviewImpact, reviewer.evidenceIds);
		candidate.reviewVerdict = input.verdict;
		candidate.reviewFindings = [...input.findings];
		candidate.residualRisks = [...input.residualRisks];
		candidate.evidenceIds = [...new Set([...candidate.evidenceIds, ...reviewer.evidenceIds])];
		candidate.planImpact = strongerPlanImpact(candidate.planImpact, reviewImpact);
		if (PLAN_IMPACT_RANK[reviewImpact.level] >= PLAN_IMPACT_RANK[candidate.planImpact?.level ?? "none"]) {
			candidate.planImpactObservationId = reviewer.planImpactObservationId;
		}
		const impactLevel = candidate.planImpact?.level ?? "none";
		candidate.status =
			impactLevel === "structural" || impactLevel === "contract"
				? "awaiting-reconciliation"
				: input.verdict === "pass" && impactLevel === "none"
					? (candidate.candidateValidators?.length ?? 0) > 0
						? "awaiting-validation"
						: "awaiting-integration"
					: "rejected";
		candidate.settledAt = ["awaiting-validation", "awaiting-integration"].includes(candidate.status)
			? undefined
			: now;
		const wave = this.#state.execution.waves.find(item => item.id === candidate.waveId);
		if (wave) {
			if (impactLevel === "structural" || impactLevel === "contract") wave.admissionOpen = false;
			this.#updateExecutionWave(wave, now);
		}
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("execution-updated");
		return cloneZZWExecutionState({ waves: [], lanes: [candidate] }).lanes[0];
	}

	async prepareRepairLane(candidateLaneId: string): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const candidate = this.#state.execution.lanes.find(lane => lane.id === candidateLaneId);
		if (
			candidate?.status !== "rejected" ||
			(candidate.reviewVerdict !== "reject" && candidate.planImpact?.level !== "execution")
		) {
			throw new Error(`lane ${candidateLaneId} is not repairable after adversarial review`);
		}
		const nextAttempt = (candidate.attempt ?? 0) + 1;
		if (nextAttempt > (candidate.maxRepairAttempts ?? 0)) {
			throw new Error(`lane ${candidateLaneId} exhausted its repair attempts`);
		}
		const step = this.#state.plan.steps.find(item => item.id === candidate.stepId);
		const wave = this.#state.execution.waves.find(item => item.id === candidate.waveId);
		if (!step || !wave || step.contractHash !== candidate.stepContractHash) {
			throw new Error(`lane ${candidateLaneId} no longer matches the approved Plan contract`);
		}
		const workspace = await this.#captureWorkspace();
		const now = this.#now();
		const lane: ZZWExecutionLane = {
			...candidate,
			id: this.#mint("lane"),
			role: "repair",
			parentLaneId: candidate.id,
			attempt: nextAttempt,
			workspaceId: workspace.workspaceId,
			baseWorkspaceHash: workspaceStateHash(workspace),
			status: "prepared",
			operationIds: [],
			artifactIds: [],
			evidenceIds: [],
			modelSelector: candidate.repairModelSelector ?? candidate.modelSelector ?? "*",
			reviewerLaneId: undefined,
			reviewVerdict: undefined,
			reviewFindings: [
				...(candidate.reviewFindings ?? []),
				...(candidate.planImpact?.level === "execution" ? [candidate.planImpact.reason] : []),
			],
			residualRisks: undefined,
			planImpact: undefined,
			planImpactObservationId: undefined,
			validatorLaneIds: undefined,
			repairAttempts: nextAttempt,
			outputDigest: undefined,
			patchPath: undefined,
			branchName: undefined,
			error: undefined,
			createdAt: now,
			startedAt: undefined,
			settledAt: undefined,
		};
		const operation: TaskOperation = {
			id: this.#mint("operation"),
			taskId: this.#state.taskId,
			attemptId: this.#state.attemptId,
			episodeId: this.#state.episodeId,
			waveId: wave.id,
			laneId: lane.id,
			toolCallId: `${wave.id}:${lane.id}:repair-${nextAttempt}`,
			toolName: "zzw-work-unit-repair",
			tier: "write",
			target: step.allowedTargets?.join(",").slice(0, 512),
			preStateHash: lane.baseWorkspaceHash,
			intendedEffect: `Repair rejected Work Unit ${candidate.workUnitId ?? candidate.stepId}`,
			idempotencyKey: `${this.#state.taskId}:${this.#state.attemptId}:${wave.id}:${lane.id}:repair-${nextAttempt}`,
			checkpointId: this.#state.checkpointId,
			planStepId: step.id,
			status: "prepared",
			preparedAt: now,
			evidenceKind: "operation",
			fingerprint: operationFingerprint(
				"zzw-work-unit-repair",
				{ candidateLaneId: candidate.id, repairLaneId: lane.id, attempt: nextAttempt },
				step.id,
				lane.baseWorkspaceHash,
			),
		};
		lane.operationIds.push(operation.id);
		candidate.status = "superseded";
		candidate.settledAt = now;
		wave.laneIds.push(lane.id);
		wave.status = "running";
		this.#state.execution.lanes.push(lane);
		this.#operations.set(operation.id, operation);
		this.#operationByToolCall.set(operation.toolCallId, operation.id);
		this.#persistOperation(operation);
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-prepared");
		await this.#syncZZWorkflowState("execution-updated");
		return cloneZZWExecutionState({ waves: [], lanes: [lane] }).lanes[0];
	}

	async finalizeAdversarialReviewFailure(candidateLaneId: string): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const candidate = this.#state.execution.lanes.find(lane => lane.id === candidateLaneId);
		if (candidate?.status !== "rejected") throw new Error(`lane ${candidateLaneId} is not rejected`);
		const now = this.#now();
		const wave = this.#state.execution.waves.find(item => item.id === candidate.waveId);
		if (wave) this.#updateExecutionWave(wave, now);
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return cloneZZWExecutionState({ waves: [], lanes: [candidate] }).lanes[0];
	}

	async failCandidateGate(candidateLaneId: string, reason: string): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const candidate = this.#state.execution.lanes.find(lane => lane.id === candidateLaneId);
		if (
			!candidate ||
			!["awaiting-review", "awaiting-validation", "awaiting-integration", "rejected"].includes(candidate.status)
		) {
			throw new Error(`lane ${candidateLaneId} has no active candidate gate`);
		}
		const now = this.#now();
		candidate.status = "rejected";
		candidate.reviewVerdict = "escalate";
		candidate.reviewFindings = [...(candidate.reviewFindings ?? []), reason];
		candidate.error = reason;
		candidate.settledAt = now;
		const wave = this.#state.execution.waves.find(item => item.id === candidate.waveId);
		if (wave) this.#updateExecutionWave(wave, now);
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return cloneZZWExecutionState({ waves: [], lanes: [candidate] }).lanes[0];
	}

	async prepareCandidateValidatorLanes(candidateLaneId: string): Promise<ZZWExecutionLane[]> {
		if (!this.#state) throw new Error("no active controlled task");
		const candidate = this.#state.execution.lanes.find(lane => lane.id === candidateLaneId);
		if (candidate?.status !== "awaiting-validation") {
			throw new Error(`lane ${candidateLaneId} is not awaiting candidate validation`);
		}
		if (candidate.validatorLaneIds?.length) {
			return cloneZZWExecutionState({
				waves: [],
				lanes: this.#state.execution.lanes.filter(lane => candidate.validatorLaneIds?.includes(lane.id)),
			}).lanes;
		}
		const step = this.#state.plan.steps.find(item => item.id === candidate.stepId);
		const wave = this.#state.execution.waves.find(item => item.id === candidate.waveId);
		if (!step || !wave) throw new Error(`candidate lane ${candidateLaneId} has no active Plan Wave`);
		const workspace = await this.#captureWorkspace();
		const now = this.#now();
		const lanes: ZZWExecutionLane[] = [];
		const operations: TaskOperation[] = [];
		for (const [index, validator] of (candidate.candidateValidators ?? []).entries()) {
			const lane: ZZWExecutionLane = {
				id: this.#mint("lane"),
				waveId: wave.id,
				stepId: candidate.stepId,
				workUnitId: candidate.workUnitId,
				role: "validator",
				parentLaneId: candidate.id,
				attempt: candidate.attempt,
				stepContractHash: candidate.stepContractHash,
				executor: "validator",
				workspaceId: workspace.workspaceId,
				baseWorkspaceHash: workspaceStateHash(workspace),
				status: "prepared",
				resourceClaims: candidate.resourceClaims.map(claim => ({ ...claim })),
				operationIds: [],
				artifactIds: [],
				evidenceIds: [],
				validators: [validator],
				maxRuntimeMs: candidate.maxRuntimeMs,
				createdAt: now,
			};
			const operation: TaskOperation = {
				id: this.#mint("operation"),
				taskId: this.#state.taskId,
				attemptId: this.#state.attemptId,
				episodeId: this.#state.episodeId,
				waveId: wave.id,
				laneId: lane.id,
				toolCallId: `${wave.id}:${lane.id}:candidate-validator-${index}`,
				toolName: "zzw-work-unit-validator",
				tier: "exec",
				target: candidate.patchPath,
				preStateHash: lane.baseWorkspaceHash,
				intendedEffect: `Validate candidate Lane ${candidate.id}: ${validator}`,
				idempotencyKey: `${this.#state.taskId}:${this.#state.attemptId}:${wave.id}:${lane.id}:candidate-validator-${index}`,
				checkpointId: this.#state.checkpointId,
				planStepId: step.id,
				status: "prepared",
				preparedAt: now,
				evidenceKind: "verification",
				validator,
				verificationIds: [],
				fingerprint: operationFingerprint(
					"zzw-work-unit-validator",
					{ candidateLaneId: candidate.id, validator },
					step.id,
					lane.baseWorkspaceHash,
				),
			};
			lane.operationIds.push(operation.id);
			wave.laneIds.push(lane.id);
			lanes.push(lane);
			operations.push(operation);
			this.#operations.set(operation.id, operation);
			this.#operationByToolCall.set(operation.toolCallId, operation.id);
			this.#persistOperation(operation);
		}
		candidate.validatorLaneIds = lanes.map(lane => lane.id);
		wave.status = "draining";
		this.#state.execution.lanes.push(...lanes);
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		for (const operation of operations) await this.#syncZZWorkflowOperation(operation, "operation-prepared");
		await this.#syncZZWorkflowState("execution-updated");
		return cloneZZWExecutionState({ waves: [], lanes }).lanes;
	}

	async completeCandidateValidation(candidateLaneId: string): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const candidate = this.#state.execution.lanes.find(lane => lane.id === candidateLaneId);
		if (candidate?.status !== "awaiting-validation" || !candidate.validatorLaneIds?.length) {
			throw new Error(`lane ${candidateLaneId} has no completed candidate validation set`);
		}
		const validators = candidate.validatorLaneIds.flatMap(id => {
			const lane = this.#state?.execution.lanes.find(item => item.id === id);
			return lane ? [lane] : [];
		});
		if (validators.some(lane => !TERMINAL_LANE_STATUSES.has(lane.status))) {
			throw new Error(`lane ${candidateLaneId} validators are still running`);
		}
		const now = this.#now();
		const allSucceeded =
			validators.length === candidate.validatorLaneIds.length &&
			validators.every(lane => lane.status === "succeeded");
		candidate.evidenceIds.push(...validators.flatMap(lane => lane.evidenceIds));
		candidate.artifactIds.push(...validators.flatMap(lane => lane.artifactIds));
		candidate.status = allSucceeded ? "awaiting-integration" : "rejected";
		candidate.error = allSucceeded
			? undefined
			: (validators.find(lane => lane.status !== "succeeded")?.error ?? "Candidate validation failed.");
		if (!allSucceeded) {
			candidate.reviewVerdict = "reject";
			candidate.reviewFindings = [
				...(candidate.reviewFindings ?? []),
				candidate.error ?? "Candidate validation failed.",
			];
		}
		candidate.settledAt = allSucceeded ? undefined : now;
		const wave = this.#state.execution.waves.find(item => item.id === candidate.waveId);
		if (wave) {
			wave.status = "draining";
			if (!allSucceeded) this.#updateExecutionWave(wave, now);
		}
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("execution-updated");
		return cloneZZWExecutionState({ waves: [], lanes: [candidate] }).lanes[0];
	}

	async prepareLaneIntegration(laneId: string): Promise<TaskOperation> {
		if (!this.#state) throw new Error("no active controlled task");
		const lane = this.#state.execution.lanes.find(candidate => candidate.id === laneId);
		if (lane?.status !== "awaiting-integration") {
			throw new Error(`lane ${laneId} is not awaiting integration`);
		}
		const step = this.#state.plan.steps.find(candidate => candidate.id === lane.stepId);
		if (!step || step.contractHash !== lane.stepContractHash) {
			throw new Error(`lane ${laneId}의 Plan step contract가 변경되어 통합할 수 없습니다.`);
		}
		const workspace = await this.#captureWorkspace();
		await this.#host.assertMutationLease?.(cloneState(this.#state));
		const now = this.#now();
		const operation: TaskOperation = {
			id: this.#mint("operation"),
			taskId: this.#state.taskId,
			attemptId: this.#state.attemptId,
			episodeId: this.#state.episodeId,
			waveId: lane.waveId,
			laneId: lane.id,
			toolCallId: `${lane.waveId}:${lane.id}:integration`,
			toolName: "zzw-integrate",
			tier: "write",
			target: step.allowedTargets?.join(",").slice(0, 512),
			preStateHash: workspaceStateHash(workspace),
			intendedEffect: `Integrate isolated lane ${lane.id} for Plan step ${step.id}`,
			idempotencyKey: `${this.#state.taskId}:${this.#state.attemptId}:${lane.waveId}:${lane.id}:integration`,
			checkpointId: this.#state.checkpointId,
			planStepId: step.id,
			status: "prepared",
			preparedAt: now,
			evidenceKind: "operation",
			fingerprint: operationFingerprint(
				"zzw-integrate",
				{ laneId: lane.id, stepId: step.id, patchPath: lane.patchPath, branchName: lane.branchName },
				step.id,
				workspaceStateHash(workspace),
			),
		};
		lane.operationIds.push(operation.id);
		this.#operations.set(operation.id, operation);
		this.#operationByToolCall.set(operation.toolCallId, operation.id);
		this.#persistOperation(operation);
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-prepared");
		operation.status = "running";
		this.#persistOperation(operation);
		this.#refreshPendingOperations();
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-running");
		await this.#syncZZWorkflowState("execution-updated");
		return cloneOperation(operation);
	}

	async cancelLaneBeforeIntegration(laneId: string, reason: string): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const lane = this.#state.execution.lanes.find(candidate => candidate.id === laneId);
		if (lane?.status !== "awaiting-integration") {
			throw new Error(`lane ${laneId} is not awaiting integration`);
		}
		const now = this.#now();
		lane.status = "cancelled";
		lane.error = reason;
		lane.settledAt = now;
		const wave = this.#state.execution.waves.find(candidate => candidate.id === lane.waveId);
		if (wave) this.#updateExecutionWave(wave, now);
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return cloneZZWExecutionState({ waves: [], lanes: [lane] }).lanes[0];
	}

	async settleLaneIntegration(input: TaskExecutionLaneIntegrationResult): Promise<ZZWExecutionLane> {
		if (!this.#state) throw new Error("no active controlled task");
		const lane = this.#state.execution.lanes.find(candidate => candidate.id === input.laneId);
		if (lane?.status !== "awaiting-integration") {
			throw new Error(`lane ${input.laneId} is not awaiting integration`);
		}
		const operation = lane.operationIds
			.map(id => this.#operations.get(id))
			.find(
				candidate =>
					candidate?.toolName === "zzw-integrate" &&
					(candidate.status === "prepared" || candidate.status === "running"),
			);
		if (!operation) throw new Error(`lane ${lane.id} has no prepared integration operation`);
		const now = this.#now();
		const workspace = await this.#captureWorkspace();
		operation.status = input.succeeded ? "committed" : "failed";
		operation.postStateHash = workspaceStateHash(workspace);
		operation.settledAt = now;
		const evidence: TaskEvidence = {
			id: this.#mint("evidence"),
			type: "tool_result",
			summary: `zzw-integrate ${input.succeeded ? "completed" : "failed"}`,
			createdAt: now,
			workspaceHash: operation.postStateHash,
			stale: false,
			outcome: input.succeeded ? "observed" : "failed",
			specVersion: this.#state.specVersion,
			planVersion: this.#state.planVersion,
			planStepId: lane.stepId,
			operationId: operation.id,
			toolName: operation.toolName,
			resultDigest: input.outputDigest,
			trust: "raw",
			stepContractHash: lane.stepContractHash,
		};
		operation.evidenceId = evidence.id;
		lane.evidenceIds.push(evidence.id);
		lane.error = input.error ?? lane.error;
		lane.status = input.succeeded ? "integrated" : "rejected";
		lane.settledAt = now;
		this.#state.evidence.push(evidence);
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#persistOperation(operation);
		const wave = this.#state.execution.waves.find(candidate => candidate.id === lane.waveId);
		if (wave) this.#updateExecutionWave(wave, now);
		this.#refreshPendingOperations();
		this.#state.updatedAt = now;
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-settled");
		await this.#syncZZWorkflowState("execution-updated");
		await this.#publishPlanProjection();
		return cloneZZWExecutionState({ waves: [], lanes: [lane] }).lanes[0];
	}

	#recordLanePlanImpact(lane: ZZWExecutionLane, impact: ZZWPlanImpact, evidenceIds: string[]): void {
		if (!this.#state) return;
		lane.planImpact = strongerPlanImpact(lane.planImpact, impact);
		if (impact.level === "none") return;
		const knownStepIds = new Set(this.#state.plan.steps.map(step => step.id));
		const knownAssumptionIds = new Set(
			this.#state.specification.statements
				.filter(statement => statement.type === "assumption")
				.map(statement => statement.id),
		);
		const affectedStepIds = [...new Set([lane.stepId, ...impact.affectedStepIds.filter(id => knownStepIds.has(id))])];
		const contradictedAssumptionIds = impact.contradictedAssumptionIds.filter(id => knownAssumptionIds.has(id));
		const statement = [
			impact.reason,
			...impact.evidence.map(item => `근거: ${item}`),
			...impact.proposedChanges.map(item => `제안: ${item}`),
		].join("\n");
		const observation: TaskObservation = {
			id: this.#mint("observation"),
			kind: impact.level === "contract" ? "risk" : impact.level === "structural" ? "contradiction" : "fact",
			statement,
			evidenceIds: [...evidenceIds],
			confidence: 0.7,
			affects: [
				...affectedStepIds.map(id => ({ type: "step" as const, id })),
				...contradictedAssumptionIds.map(id => ({ type: "assumption" as const, id })),
			],
			createdAt: this.#now(),
		};
		this.#state.observations ??= [];
		this.#state.observations.push(observation);
		lane.planImpactObservationId = observation.id;
	}

	#updateExecutionWave(wave: ZZWExecutionWave, now: number): void {
		if (!this.#state) return;
		const waveLanes = wave.laneIds.flatMap(id => {
			const candidate = this.#state?.execution.lanes.find(item => item.id === id);
			return candidate ? [candidate] : [];
		});
		const outcomeLanes = selectZZWExecutionOutcomeLanes(waveLanes);
		if (
			waveLanes.some(candidate =>
				["awaiting-review", "awaiting-validation", "awaiting-integration"].includes(candidate.status),
			)
		) {
			wave.status = "draining";
			return;
		}
		if (!outcomeLanes.every(candidate => TERMINAL_LANE_STATUSES.has(candidate.status))) return;
		if (wave.admissionOpen === true) {
			wave.status = "running";
			return;
		}
		wave.status = outcomeLanes.some(candidate =>
			["failed", "rejected", "awaiting-reconciliation"].includes(candidate.status),
		)
			? "reconciling"
			: outcomeLanes.some(
						candidate =>
							candidate.status === "cancelled" ||
							candidate.status === "unknown" ||
							candidate.status === "interrupted",
					)
				? "interrupted"
				: "settled";
		wave.settledAt = now;
		this.#state.execution.activeWaveId = undefined;
		const cancelledStepIds = new Set(
			outcomeLanes.filter(candidate => candidate.status === "cancelled").map(candidate => candidate.stepId),
		);
		for (const stepId of cancelledStepIds) {
			const step = this.#state.plan.steps.find(candidate => candidate.id === stepId);
			if (step?.status === "in_progress" && step.rerunPolicy !== "never") step.status = "pending";
		}
		const failedLane =
			outcomeLanes.find(candidate => candidate.status === "awaiting-reconciliation") ??
			outcomeLanes.find(candidate => ["failed", "interrupted", "unknown", "rejected"].includes(candidate.status));
		if (!failedLane) {
			if (wave.status === "interrupted") this.#state.phase = "READY";
			return;
		}
		const step = this.#state.plan.steps.find(candidate => candidate.id === failedLane.stepId);
		if (step) step.status = "blocked";
		const planImpact = failedLane.planImpact;
		const planChangeRequired = planImpact?.level === "structural" || planImpact?.level === "contract";
		if (planChangeRequired) {
			this.#state.stalePlan = true;
			this.#state.plan.status = "stale";
		}
		this.#state.reconciliation = {
			stepId: failedLane.stepId,
			laneId: failedLane.id,
			operationId: failedLane.operationIds.at(-1),
			observationId: failedLane.planImpactObservationId,
			evidenceIds: [...failedLane.evidenceIds],
			planImpact: cloneZZWPlanImpact(planImpact),
			classification: planImpact
				? planImpactClassification(planImpact)
				: failedLane.executor === "validator"
					? "verification-failure"
					: "execution-failure",
			repeatedFailures: 1,
			requiredAction:
				planImpact?.level === "contract"
					? "request-user"
					: planImpact?.level === "structural"
						? "patch-plan"
						: "classify-result",
			createdAt: now,
		};
		this.#state.phase =
			planImpact?.level === "contract"
				? "AWAITING_USER"
				: planImpact?.level === "structural"
					? "REPLANNING"
					: "RECONCILING";
	}

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}

	#mint(kind: Parameters<NonNullable<TaskLifecycleHost["mintId"]>>[0]): string {
		return this.#host.mintId?.(kind) ?? `${kind}-${Snowflake.next()}`;
	}

	async #captureWorkspace(): Promise<TaskWorkspaceSnapshot> {
		return this.#host.captureWorkspace?.() ?? captureTaskWorkspace(this.#host.getCwd(), this.#now());
	}

	#persistState(): void {
		if (!this.#state) return;
		const envelope: LifecycleSnapshotEnvelope = {
			schemaVersion: TASK_LIFECYCLE_SCHEMA_VERSION,
			kind: "snapshot",
			state: cloneState(this.#state),
		};
		this.#host.appendCustomEntry(TASK_LIFECYCLE_ENTRY_TYPE, envelope);
	}

	#persistOperation(operation: TaskOperation): void {
		const envelope: OperationEnvelope = {
			schemaVersion: TASK_LIFECYCLE_SCHEMA_VERSION,
			kind: "operation",
			operation: cloneOperation(operation),
		};
		this.#host.appendCustomEntry(TASK_OPERATION_ENTRY_TYPE, envelope);
	}

	async #syncZZWorkflowState(
		reason: Parameters<NonNullable<TaskLifecycleHost["syncZZWorkflowState"]>>[1],
	): Promise<void> {
		if (!this.#state) return;
		await this.#host.syncZZWorkflowState?.(cloneState(this.#state), reason);
	}

	async #syncZZWorkflowOperation(
		operation: TaskOperation,
		reason: Parameters<NonNullable<TaskLifecycleHost["syncZZWorkflowOperation"]>>[2],
	): Promise<void> {
		if (!this.#state) return;
		await this.#host.syncZZWorkflowOperation?.(cloneState(this.#state), cloneOperation(operation), reason);
	}

	async #publishPlanProjection(): Promise<void> {
		if (!this.#state) return;
		await this.#host.publishPlanProjection?.(cloneState(this.#state));
	}

	async #recallKnowledge(stage: "intake" | "planning" | "recovery"): Promise<void> {
		if (!this.#state) return;
		this.#knowledgeWorkingSet = await this.#host.recallTaskKnowledge?.(cloneState(this.#state), stage);
	}

	#setPhase(phase: TaskLifecyclePhase): void {
		if (!this.#state || this.#state.phase === phase) return;
		if (TERMINAL_PHASES.has(this.#state.phase)) return;
		this.#state.phase = phase;
		this.#state.updatedAt = this.#now();
		this.#persistState();
	}

	#refreshPendingOperations(): void {
		if (!this.#state) return;
		this.#state.pendingOperationIds = [...this.#operations.values()]
			.filter(
				operation =>
					operation.taskId === this.#state?.taskId &&
					(operation.status === "prepared" || operation.status === "running" || operation.status === "unknown"),
			)
			.map(operation => operation.id);
	}

	rehydrate(): void {
		this.#state = undefined;
		this.#operations.clear();
		this.#operationByToolCall.clear();
		for (const entry of this.#host.getEntries()) {
			const state = lifecycleStateFromEntry(entry, this.#state);
			if (state) this.#state = state;
			const operation = operationFromEntry(entry);
			if (!operation) continue;
			this.#operations.set(operation.id, operation);
			this.#operationByToolCall.set(operation.toolCallId, operation.id);
		}
		if (this.#state) {
			for (const wave of this.#state.execution.waves) {
				if (wave.admissionOpen === true) wave.admissionOpen = false;
			}
			for (const operation of this.#operations.values()) {
				if (!operation.laneId) continue;
				const lane = this.#state.execution.lanes.find(candidate => candidate.id === operation.laneId);
				if (lane && !lane.operationIds.includes(operation.id)) lane.operationIds.push(operation.id);
			}
			for (const operation of this.#operations.values()) {
				if (operation.status !== "running") continue;
				operation.status = "unknown";
				const lane = this.#state.execution.lanes.find(
					candidate => candidate.id === operation.laneId || candidate.operationIds.includes(operation.id),
				);
				if (lane && ["prepared", "running", "cancel-requested"].includes(lane.status)) lane.status = "unknown";
				const wave = lane ? this.#state.execution.waves.find(candidate => candidate.id === lane.waveId) : undefined;
				if (wave) wave.status = "interrupted";
			}
			const now = this.#now();
			for (const lane of this.#state.execution.lanes) {
				const operations = lane.operationIds.flatMap(id => {
					const operation = this.#operations.get(id);
					return operation ? [operation] : [];
				});
				const integrationOperations = operations.filter(operation => operation.toolName === "zzw-integrate");
				if (
					["awaiting-review", "awaiting-validation"].includes(lane.status) ||
					(lane.status === "awaiting-integration" && integrationOperations.length === 0)
				) {
					lane.status = "interrupted";
					lane.error =
						"Candidate Lane did not finish its review, validation, and integration gate before restart.";
					lane.settledAt = now;
					const wave = this.#state.execution.waves.find(candidate => candidate.id === lane.waveId);
					if (wave) this.#updateExecutionWave(wave, now);
					continue;
				}
				const integrationMismatch = integrationOperations.find(
					operation =>
						(operation.status === "committed" && lane.status !== "integrated") ||
						(operation.status === "failed" && lane.status !== "rejected"),
				);
				if (integrationMismatch) {
					integrationMismatch.status = "unknown";
					lane.status = "unknown";
					lane.error = "Integration operation and Lane state disagree after restart.";
					const wave = this.#state.execution.waves.find(candidate => candidate.id === lane.waveId);
					if (wave) wave.status = "interrupted";
				}
			}
			for (const wave of this.#state.execution.waves.filter(candidate => candidate.status === "settled")) {
				const waveLanes = wave.laneIds.flatMap(id => {
					const lane = this.#state?.execution.lanes.find(candidate => candidate.id === id);
					return lane ? [lane] : [];
				});
				for (const stepId of new Set(waveLanes.map(lane => lane.stepId))) {
					const step = this.#state.plan.steps.find(candidate => candidate.id === stepId);
					if (step?.status !== "in_progress") continue;
					const stepLanes = selectZZWExecutionOutcomeLanes(waveLanes.filter(lane => lane.stepId === stepId));
					const lanesSucceeded = stepLanes.every(lane =>
						lane.executor === "subagent-isolated" ? lane.status === "integrated" : lane.status === "succeeded",
					);
					if (!lanesSucceeded) continue;
					const evidence = stepLanes.flatMap(lane =>
						lane.evidenceIds.flatMap(id => {
							const item = this.#state?.evidence.find(candidate => candidate.id === id);
							return item ? [item] : [];
						}),
					);
					if (isValidationStep(step)) {
						const workspaceHash = workspaceStateHash(this.#state.workspace);
						const current = evidence.filter(
							item =>
								item.type === "verification" &&
								item.trust === "verified" &&
								item.outcome === "passed" &&
								!item.stale &&
								item.specVersion === this.#state?.specVersion &&
								item.planStepId === step.id &&
								item.workspaceHash === workspaceHash &&
								(item.planVersion === this.#state?.planVersion || item.stepContractHash === step.contractHash),
						);
						const validatorsSatisfied = (step.validators ?? []).every(validator =>
							current.some(item => item.validator === validator),
						);
						const requirementsSatisfied = (step.verificationIds ?? []).every(verificationId =>
							current.some(item => item.verificationIds?.includes(verificationId) === true),
						);
						if ((step.validators?.length ?? 0) > 0 && validatorsSatisfied && requirementsSatisfied) {
							step.status = "completed";
						}
					} else if (evidence.some(item => item.outcome !== "failed")) {
						step.status = "completed";
					}
				}
			}
			this.#state.readiness = readinessFor(
				this.#state.specification,
				this.#state.workspace,
				this.#state.checkpoint,
				this.#state.plan,
			);
		}
		this.#refreshPendingOperations();
		if (this.#state && this.#state.pendingOperationIds.length > 0 && !TERMINAL_PHASES.has(this.#state.phase)) {
			this.#state.phase = "RECOVERING";
		}
	}

	clear(): void {
		this.#state = undefined;
		this.#operations.clear();
		this.#operationByToolCall.clear();
		this.#knowledgeWorkingSet = undefined;
	}

	async #createTask(goal: Goal): Promise<void> {
		const now = this.#now();
		const sessionId = this.#host.getSessionId();
		const workspace = await this.#captureWorkspace();
		const checkpoint: TaskCheckpoint = {
			id: this.#mint("checkpoint"),
			createdAt: now,
			phase: "PREPARATION",
			planVersion: 1,
			workspaceHash: workspaceStateHash(workspace),
			verified: true,
		};
		const episode: TaskEpisode = {
			id: this.#mint("episode"),
			sessionId,
			startedAt: now,
			startWorkspace: cloneWorkspace(workspace),
		};
		const specification = specificationFromGoal(goal, sessionId, 1, () => this.#mint("statement"));
		const plan = planFromSpecification(specification, 1);
		this.#state = {
			schemaVersion: TASK_LIFECYCLE_SCHEMA_VERSION,
			taskId: goal.id,
			specVersion: 1,
			attemptId: this.#mint("attempt"),
			sessionId,
			episodeId: episode.id,
			workspaceId: workspace.workspaceId,
			planVersion: 1,
			checkpointId: checkpoint.id,
			phase: "INTAKE",
			specification,
			workspace,
			readiness: readinessFor(specification, workspace, checkpoint, plan),
			plan,
			checkpoint,
			episode,
			evidence: [],
			observations: [],
			execution: cloneZZWExecutionState(EMPTY_ZZW_EXECUTION_STATE),
			pendingOperationIds: [],
			stalePlan: false,
			createdAt: now,
			updatedAt: now,
		};
		this.#persistState();
		for (const phase of ["DISCOVERY", "SPECIFICATION", "PREPARATION"] as const) {
			this.#setPhase(phase);
		}
		this.#setPhase(this.#state.readiness.ready ? "READY" : "AWAITING_USER");
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowState("created");
		await this.#publishPlanProjection();
		await this.#recallKnowledge("intake");
	}

	async #startEpisode(goal: Goal, active: boolean): Promise<void> {
		if (!this.#state || this.#state.taskId !== goal.id) {
			await this.#createTask(goal);
		}
		await this.startNewEpisode(active);
	}

	async startNewEpisode(active: boolean): Promise<void> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) return;
		const workspace = await this.#captureWorkspace();
		const diverged = !sameWorkspaceState(this.#state.workspace, workspace);
		const now = this.#now();
		const episode: TaskEpisode = {
			id: this.#mint("episode"),
			sessionId: this.#host.getSessionId(),
			startedAt: now,
			startWorkspace: cloneWorkspace(workspace),
		};
		this.#state.sessionId = episode.sessionId;
		this.#state.episodeId = episode.id;
		this.#state.episode = episode;
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#state.handoff = undefined;
		this.#state.updatedAt = now;
		if (diverged) {
			this.#state.stalePlan = true;
			this.#state.plan.status = "stale";
			this.#state.evidence = this.#state.evidence.map(item => ({
				...item,
				stale: true,
				staleReason: "workspace-changed",
			}));
			this.#state.phase = "RECOVERING";
		} else {
			this.#state.phase = active ? (this.#state.readiness.ready ? "READY" : "AWAITING_USER") : "SUSPENDED";
		}
		this.#refreshPendingOperations();
		if (this.#state.pendingOperationIds.length > 0) this.#state.phase = "RECOVERING";
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowState("episode-started");
		await this.#publishPlanProjection();
		await this.#recallKnowledge(
			this.#state.phase === "RECOVERING" || this.#state.pendingOperationIds.length > 0 ? "recovery" : "planning",
		);
	}

	async prepareHandoff(): Promise<TaskLifecycleHandoff | undefined> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) return undefined;
		this.#setPhase("PAUSING");
		const workspace = await this.#captureWorkspace();
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#state.episode.endedAt = this.#now();
		this.#state.episode.endReason = "handoff";
		this.#state.phase = "SUSPENDED";
		this.#refreshPendingOperations();
		this.#state.handoff = this.#buildHandoffPacket();
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowState("handoff");
		return {
			state: cloneState(this.#state),
			operations: [...this.#operations.values()]
				.filter(operation => operation.taskId === this.#state?.taskId)
				.map(cloneOperation),
		};
	}

	async resumeHandoff(handoff: TaskLifecycleHandoff): Promise<void> {
		this.#state = cloneState(handoff.state);
		this.#operations.clear();
		this.#operationByToolCall.clear();
		for (const operation of handoff.operations) {
			const cloned = cloneOperation(operation);
			this.#operations.set(cloned.id, cloned);
			this.#operationByToolCall.set(cloned.toolCallId, cloned.id);
			this.#persistOperation(cloned);
		}
		await this.startNewEpisode(true);
	}

	async #pause(reason: "user" | "interrupted"): Promise<void> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) return;
		this.#setPhase(reason === "interrupted" ? "INTERRUPTED" : "PAUSING");
		const workspace = await this.#captureWorkspace();
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#state.episode.endedAt = this.#now();
		this.#state.episode.endReason = reason === "interrupted" ? "interrupted" : "paused";
		this.#state.phase = "SUSPENDED";
		this.#refreshPendingOperations();
		this.#state.handoff = this.#buildHandoffPacket();
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowState("paused");
	}

	#buildHandoffPacket(): TaskHandoffPacket {
		if (!this.#state) throw new Error("cannot build a handoff without an active task");
		const pending = [...this.#state.pendingOperationIds];
		return {
			taskId: this.#state.taskId,
			attemptId: this.#state.attemptId,
			sessionId: this.#state.sessionId,
			episodeId: this.#state.episodeId,
			specVersion: this.#state.specVersion,
			planVersion: this.#state.planVersion,
			workspace: cloneWorkspace(this.#state.workspace),
			phase: this.#state.phase,
			checkpointId: this.#state.checkpointId,
			pendingOperationIds: pending,
			staleEvidenceIds: this.#state.evidence.filter(item => item.stale).map(item => item.id),
			activePlanStepId: activePlanStep(this.#state.plan)?.id,
			plan: {
				...this.#state.plan,
				steps: this.#state.plan.steps.map(step => ({ ...step, dependsOn: [...step.dependsOn] })),
			},
			nextSafeAction:
				pending.length > 0
					? `Inspect and reconcile prepared operation ${pending[0]} before starting another mutation`
					: activePlanStep(this.#state.plan)?.content || "Reconcile the workspace snapshot and verify completion",
		};
	}

	async handleGoalEvent(event: GoalLifecycleEvent): Promise<void> {
		switch (event.type) {
			case "created":
				await this.#createTask(event.goal);
				await this.#syncZZWorkflowState("replaced");
				return;
			case "replaced":
				if (this.#state && !TERMINAL_PHASES.has(this.#state.phase)) {
					this.#state.phase = "ABANDONED";
					this.#state.episode.endedAt = this.#now();
					this.#state.episode.endReason = "abandoned";
					this.#state.updatedAt = this.#now();
					this.#persistState();
				}
				await this.#createTask(event.goal);
				return;
			case "revised": {
				if (!this.#state || this.#state.taskId !== event.goal.id) {
					await this.#createTask(event.goal);
					return;
				}
				this.#state.specVersion++;
				const previousPlanVersion = this.#state.planVersion;
				this.#state.planVersion++;
				this.#state.specification = specificationFromGoal(
					event.goal,
					this.#host.getSessionId(),
					this.#state.specVersion,
					() => this.#mint("statement"),
				);
				this.#state.stalePlan = true;
				this.#state.plan.version = this.#state.planVersion;
				this.#state.plan.basedOnVersion = previousPlanVersion;
				this.#state.plan.status = "stale";
				this.#state.plan.approval = "draft";
				this.#state.plan.approvedAt = undefined;
				this.#state.plan.approvedBySessionId = undefined;
				const invalidatedStepIds = this.#state.plan.steps
					.filter(step => step.status !== "superseded" && step.status !== "abandoned")
					.map(step => step.id);
				this.#state.plan.steps = this.#state.plan.steps.map(step => ({
					...step,
					status: step.status === "superseded" || step.status === "abandoned" ? step.status : "invalidated",
				}));
				this.#state.plan.approvalImpact = "material";
				this.#state.plan.changes = [
					...(this.#state.plan.changes ?? []),
					{
						planVersion: this.#state.planVersion,
						basedOnPlanVersion: previousPlanVersion,
						kind: "repair",
						classification: "new-discovery",
						observationIds: [],
						evidenceIds: [],
						failedStepIds: [],
						contradictedAssumptionIds: [],
						addedStepIds: [],
						updatedStepIds: [],
						supersededStepIds: [],
						invalidatedStepIds,
						preservedStepIds: [],
						approvalImpact: "material",
						rationale: "사용자가 Task Contract를 변경하여 기존 Plan 계약과 증거를 재검토해야 합니다.",
						createdAt: this.#now(),
					},
				];
				this.#state.evidence = this.#state.evidence.map(item => ({
					...item,
					stale: true,
					staleReason: "spec-changed",
				}));
				this.#state.phase = "REPLANNING";
				this.#state.updatedAt = this.#now();
				this.#persistState();
				await this.#host.ensureOnDisk();
				await this.#host.flush();
				await this.#syncZZWorkflowState("revised");
				await this.#recallKnowledge("planning");
				return;
			}
			case "resumed":
				await this.#startEpisode(event.goal, true);
				return;
			case "thread_resumed":
				await this.#startEpisode(event.goal, event.active);
				return;
			case "paused":
				await this.#pause(event.reason);
				return;
			case "budget_limited":
				this.#setPhase("AWAITING_USER");
				await this.#host.ensureOnDisk();
				await this.#host.flush();
				return;
			case "completed": {
				if (!this.#state) return;
				this.#setPhase("VERIFYING");
				this.#setPhase("COMPLETING");
				this.#state.phase = "COMPLETED";
				this.#state.episode.endedAt = this.#now();
				this.#state.episode.endReason = "completed";
				this.#state.evidence.push({
					id: this.#mint("evidence"),
					type: "acceptance",
					summary: "The goal completion gate was explicitly satisfied",
					createdAt: this.#now(),
					workspaceHash: workspaceStateHash(this.#state.workspace),
					stale: false,
					outcome: "passed",
					specVersion: this.#state.specVersion,
				});
				this.#state.updatedAt = this.#now();
				this.#persistState();
				await this.#host.ensureOnDisk();
				await this.#host.flush();
				await this.#host.requestTaskKnowledgeReview?.(cloneState(this.#state));
				await this.#syncZZWorkflowState("completed");
				return;
			}
			case "dropped":
				if (!this.#state) return;
				this.#state.phase = "ABANDONED";
				this.#state.episode.endedAt = this.#now();
				this.#state.episode.endReason = "abandoned";
				this.#state.updatedAt = this.#now();
				this.#persistState();
				await this.#host.ensureOnDisk();
				await this.#host.flush();
				await this.#syncZZWorkflowState("abandoned");
		}
	}

	async proposePlan(input: { basedOnSpecVersion: number; steps: TaskPlanStepProposal[] }): Promise<TaskPlan> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) throw new Error("no active controlled task");
		if (this.#state.execution.activeWaveId || this.#state.pendingOperationIds.length > 0) {
			throw new Error("Execution Wave와 미해결 operation을 먼저 종료·복구한 뒤 Plan을 교체하세요.");
		}
		if (input.basedOnSpecVersion !== this.#state.specVersion) {
			throw new Error(
				`STALE_SPEC_VERSION: current specification version is ${this.#state.specVersion}; read ZZWorkflow state and retry`,
			);
		}
		const workspace = await this.#captureWorkspace();
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		const specification = this.#state.specification;
		const nextVersion = this.#state.planVersion + 1;
		const previousVersion = this.#state.planVersion;
		const steps = input.steps.map(step => normalizePlanStep(step, specification, nextVersion));
		validatePlanSteps(steps, specification, this.#planValidationOptions());
		this.#state.planVersion = nextVersion;
		this.#state.plan = {
			version: nextVersion,
			basedOnVersion: previousVersion,
			status: "current",
			approval: "draft",
			approvalImpact: "material",
			changes: [
				...(this.#state.plan.changes ?? []),
				{
					planVersion: nextVersion,
					basedOnPlanVersion: previousVersion,
					kind: this.#state.plan.changes?.length ? "repair" : "initial",
					classification: "new-discovery",
					observationIds: [],
					evidenceIds: [],
					failedStepIds: [],
					contradictedAssumptionIds: [],
					addedStepIds: steps.map(step => step.id),
					updatedStepIds: [],
					supersededStepIds: this.#state.plan.steps.map(step => step.id),
					invalidatedStepIds: [],
					preservedStepIds: [],
					approvalImpact: "material",
					rationale: this.#state.plan.changes?.length
						? "변경된 Task Contract를 실행 가능한 Plan DAG로 다시 구체화했습니다."
						: "승인된 Task Contract를 실행 가능한 최초 Plan DAG로 구체화했습니다.",
					createdAt: this.#now(),
				},
			],
			steps,
		};
		this.#state.stalePlan = false;
		this.#state.evidence = this.#state.evidence.map(evidence => ({
			...evidence,
			stale: true,
			staleReason: "step-contract-changed",
		}));
		const checkpoint: TaskCheckpoint = {
			id: this.#mint("checkpoint"),
			createdAt: this.#now(),
			phase: "PREPARATION",
			planVersion: nextVersion,
			workspaceHash: workspaceStateHash(this.#state.workspace),
			verified: true,
		};
		this.#state.checkpoint = checkpoint;
		this.#state.checkpointId = checkpoint.id;
		this.#state.readiness = readinessFor(
			this.#state.specification,
			this.#state.workspace,
			checkpoint,
			this.#state.plan,
		);
		this.#refreshPendingOperations();
		this.#state.phase = this.#state.pendingOperationIds.length > 0 ? "RECOVERING" : "AWAITING_USER";
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowState("plan-updated");
		await this.#publishPlanProjection();
		await this.#recallKnowledge("planning");
		return { ...this.#state.plan, steps: this.#state.plan.steps.map(step => ({ ...step })) };
	}

	async approvePlan(): Promise<TaskPlan> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) throw new Error("no active controlled task");
		if (this.#state.execution.activeWaveId || this.#state.pendingOperationIds.length > 0) {
			throw new Error("Execution Wave와 미해결 operation을 먼저 종료·복구한 뒤 Plan을 승인하세요.");
		}
		if (this.#state.reconciliation) {
			throw new Error("active reconciliation must be classified and resolved before Plan approval can continue");
		}
		if (this.#state.stalePlan || this.#state.plan.status === "stale") {
			throw new Error("stale plan cannot be approved; propose a reconciled plan first");
		}
		const validationOptions = this.#planValidationOptions();
		const approvalSteps = normalizeLegacyDelegationAssessmentsForApproval(
			this.#state.plan.steps,
			this.#state.specification,
			validationOptions.requireDelegationAssessment === true,
		);
		validatePlanSteps(approvalSteps, this.#state.specification, validationOptions);
		this.#state.plan.steps = approvalSteps;
		this.#state.plan.approval = "approved";
		this.#state.plan.approvedAt = this.#now();
		this.#state.plan.approvedBySessionId = this.#host.getSessionId();
		this.#state.readiness = readinessFor(
			this.#state.specification,
			this.#state.workspace,
			this.#state.checkpoint,
			this.#state.plan,
		);
		this.#state.phase = this.#state.readiness.ready ? "READY" : "PREPARATION";
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowState("plan-updated");
		await this.#publishPlanProjection();
		return cloneState(this.#state).plan;
	}

	async patchPlan(patch: TaskPlanPatch): Promise<TaskPlan> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) throw new Error("no active controlled task");
		if (this.#state.execution.activeWaveId || this.#state.pendingOperationIds.length > 0) {
			throw new Error("Execution Wave와 미해결 operation을 먼저 종료·복구한 뒤 Plan을 수정하세요.");
		}
		if (patch.basedOnPlanVersion !== this.#state.planVersion) {
			throw new Error(
				`STALE_PLAN_VERSION: current plan version is ${this.#state.planVersion}; read ZZWorkflow state and retry`,
			);
		}
		if (
			this.#state.reconciliation &&
			this.#state.reconciliation.requiredAction !== "patch-plan" &&
			!this.#state.stalePlan
		) {
			throw new Error(
				`PLAN_PATCH_NOT_REQUIRED: reconciliation action is ${this.#state.reconciliation.requiredAction}; classify routine feedback or change the retry condition before changing the Plan`,
			);
		}
		const currentPlan = this.#state.plan;
		const specification = this.#state.specification;
		if (patch.addSteps.length === 0 && patch.updateSteps.length === 0 && patch.removeStepIds.length === 0) {
			throw new Error(
				"EMPTY_PLAN_PATCH: a Plan patch must change at least one step; use changed_condition for a guarded retry",
			);
		}
		const currentById = new Map(currentPlan.steps.map(step => [step.id, step]));
		const preserveIds = new Set(patch.preserveStepIds);
		const removeIds = new Set(patch.removeStepIds);
		const updates = new Map(patch.updateSteps.map(step => [step.id, step]));
		for (const id of [...removeIds, ...updates.keys(), ...preserveIds, ...patch.failedStepIds]) {
			if (!currentById.has(id)) throw new Error(`unknown plan step in patch: ${id}`);
		}
		for (const id of removeIds) {
			if (updates.has(id)) throw new Error(`step ${id} cannot be updated and removed in the same Plan patch`);
		}
		for (const update of patch.updateSteps) {
			if (currentById.get(update.id)?.status === "completed") {
				throw new Error(`completed step ${update.id} is immutable; add a replacement step with supersedes instead`);
			}
		}
		const addedIds = new Set<string>();
		for (const step of patch.addSteps) {
			if (currentById.has(step.id) || addedIds.has(step.id)) {
				throw new Error(`Plan patch step ID must be new and unique: ${step.id}`);
			}
			addedIds.add(step.id);
			for (const supersededId of step.supersedes ?? []) {
				if (!currentById.has(supersededId)) throw new Error(`unknown superseded step: ${supersededId}`);
			}
		}
		const referencedObservations = (patch.observationIds ?? []).map(observationId => {
			const observation = (this.#state?.observations ?? []).find(candidate => candidate.id === observationId);
			if (!observation) {
				throw new Error(`unknown observation id: ${observationId}`);
			}
			return observation;
		});
		for (const evidenceId of patch.evidenceIds ?? []) {
			if (!this.#state.evidence.some(evidence => evidence.id === evidenceId)) {
				throw new Error(`unknown evidence id: ${evidenceId}`);
			}
		}

		const directAffectedIds = new Set<string>([
			...removeIds,
			...updates.keys(),
			...patch.failedStepIds,
			...patch.addSteps.flatMap(step => step.supersedes ?? []),
			...referencedObservations.flatMap(observation =>
				observation.affects.filter(affected => affected.type === "step").map(affected => affected.id),
			),
			...currentPlan.steps
				.filter(step =>
					(step.consumesArtifacts ?? []).some(artifactId =>
						referencedObservations.some(observation =>
							observation.affects.some(affected => affected.type === "artifact" && affected.id === artifactId),
						),
					),
				)
				.map(step => step.id),
			...currentPlan.steps
				.filter(step =>
					(step.assumptionIds ?? []).some(
						id =>
							patch.contradictedAssumptions.includes(id) ||
							referencedObservations.some(observation =>
								observation.affects.some(affected => affected.type === "assumption" && affected.id === id),
							),
					),
				)
				.map(step => step.id),
		]);
		const affectedIds = new Set<string>();
		for (const stepId of directAffectedIds) {
			for (const affectedId of downstreamStepIds(currentPlan, stepId)) affectedIds.add(affectedId);
		}
		for (const id of preserveIds) {
			if (affectedIds.has(id) && currentById.get(id)?.status === "completed") {
				throw new Error(`completed step ${id} depends on changed Plan input and cannot be preserved`);
			}
		}

		const nextVersion = this.#state.planVersion + 1;
		const replacementIds = new Map<string, string[]>();
		for (const added of patch.addSteps) {
			for (const supersededId of added.supersedes ?? []) {
				const replacements = replacementIds.get(supersededId) ?? [];
				replacements.push(added.id);
				replacementIds.set(supersededId, replacements);
			}
		}
		const steps: TaskPlanStep[] = currentPlan.steps.map(step => {
			const update = updates.get(step.id);
			const replacements = replacementIds.get(step.id) ?? [];
			let status = step.status;
			if (replacements.length > 0) status = "superseded";
			else if (removeIds.has(step.id)) status = "invalidated";
			else if (update) status = "pending";
			else if (affectedIds.has(step.id)) status = step.status === "completed" ? "invalidated" : "pending";
			const changed: TaskPlanStep = {
				...step,
				phase: update?.phase ?? step.phase,
				content: update?.content ?? step.content,
				kind: update?.kind ?? step.kind,
				status,
				dependsOn: [...(update?.dependsOn ?? step.dependsOn)],
				expectedEffects: [...(update?.expectedEffects ?? step.expectedEffects ?? [])],
				allowedTools: [...(update?.allowedTools ?? step.allowedTools ?? [])],
				allowedTargets: [...(update?.allowedTargets ?? step.allowedTargets ?? [])],
				postconditions: [...(update?.postconditions ?? step.postconditions ?? [])],
				successConditionIds: [...(update?.successConditionIds ?? step.successConditionIds ?? [])],
				verificationIds: [...(update?.verificationIds ?? step.verificationIds ?? [])],
				successConditions: [...(update?.successConditions ?? step.successConditions ?? [])],
				validators: [...(update?.validators ?? step.validators ?? [])],
				rerunPolicy: update?.rerunPolicy ?? step.rerunPolicy,
				riskClass: update?.riskClass ?? step.riskClass,
				parentStepId: update?.parentStepId ?? step.parentStepId,
				supersedes: [...(update?.supersedes ?? step.supersedes ?? [])],
				supersededBy: replacements.length > 0 ? replacements : [...(step.supersededBy ?? [])],
				assumptionIds: [...(update?.assumptionIds ?? step.assumptionIds ?? [])],
				consumesArtifacts: [...(update?.consumesArtifacts ?? step.consumesArtifacts ?? [])],
				producesArtifacts: [...(update?.producesArtifacts ?? step.producesArtifacts ?? [])],
				execution: update?.execution
					? cloneZZWStepExecutionContract(update.execution)
					: step.execution
						? cloneZZWStepExecutionContract(step.execution)
						: undefined,
				originPlanVersion: step.originPlanVersion ?? currentPlan.version,
				lastChangedPlanVersion: update || removeIds.has(step.id) ? nextVersion : step.lastChangedPlanVersion,
			};
			return normalizePlanStepReferences(changed, specification);
		});
		steps.push(...patch.addSteps.map(step => normalizePlanStep(step, specification, nextVersion)));
		const normalizedSteps = steps.map(step => normalizePlanStepReferences(step, specification));
		validatePlanSteps(normalizedSteps, specification, this.#planValidationOptions());
		const approvalImpact: TaskPlanApprovalImpact = currentPlan.steps.some(
			step => step.status === "completed" && affectedIds.has(step.id),
		)
			? "material"
			: patchApprovalImpact(currentPlan, patch);
		const approvalMode = this.#host.planPatchApprovalMode?.() ?? "material";
		const carryApproval =
			currentPlan.approval === "approved" && approvalMode === "material" && approvalImpact === "structural";
		const supersededStepIds = normalizedSteps
			.filter(step => step.status === "superseded" && replacementIds.has(step.id))
			.map(step => step.id);
		const invalidatedStepIds = normalizedSteps.filter(step => step.status === "invalidated").map(step => step.id);
		const preservedStepIds = currentPlan.steps
			.filter(step => step.status === "completed" && !affectedIds.has(step.id))
			.map(step => step.id);
		const inferredClassification = planChangeClassification(patch);
		const reconciliationClassification = this.#state.reconciliation?.classification;
		const change: TaskPlanChange = {
			planVersion: nextVersion,
			basedOnPlanVersion: currentPlan.version,
			kind:
				patch.changeKind ??
				(patch.failedStepIds.length > 0 || patch.contradictedAssumptions.length > 0
					? "repair"
					: patch.addSteps.length > 0
						? "expansion"
						: "patch"),
			classification:
				inferredClassification === "new-discovery" &&
				reconciliationClassification &&
				reconciliationClassification !== "matched"
					? reconciliationClassification
					: inferredClassification,
			observationIds: [...(patch.observationIds ?? [])],
			evidenceIds: [...(patch.evidenceIds ?? [])],
			failedStepIds: [...patch.failedStepIds],
			contradictedAssumptionIds: [...patch.contradictedAssumptions],
			addedStepIds: patch.addSteps.map(step => step.id),
			updatedStepIds: patch.updateSteps.map(step => step.id),
			supersededStepIds,
			invalidatedStepIds,
			preservedStepIds,
			approvalImpact,
			rationale: patch.rationale,
			createdAt: this.#now(),
		};
		this.#state.planVersion = nextVersion;
		this.#state.plan = {
			version: nextVersion,
			basedOnVersion: currentPlan.version,
			status: "current",
			approval: carryApproval ? "approved" : "draft",
			approvedAt: carryApproval ? currentPlan.approvedAt : undefined,
			approvedBySessionId: carryApproval ? currentPlan.approvedBySessionId : undefined,
			approvalImpact,
			changes: [...(currentPlan.changes ?? []), change],
			steps: normalizedSteps,
		};
		this.#state.stalePlan = false;
		this.#state.reconciliation = undefined;
		this.#state.evidence = this.#state.evidence.map(evidence => {
			if (!evidence.planStepId || !affectedIds.has(evidence.planStepId)) return evidence;
			const changedStep = this.#state?.plan.steps.find(step => step.id === evidence.planStepId);
			const staleReason: TaskEvidenceStaleReason =
				changedStep?.status === "superseded"
					? "superseded"
					: directAffectedIds.has(evidence.planStepId)
						? "step-contract-changed"
						: "dependency-invalidated";
			return { ...evidence, stale: true, staleReason };
		});
		this.#state.checkpoint = {
			id: this.#mint("checkpoint"),
			createdAt: this.#now(),
			phase: "REPLANNING",
			planVersion: nextVersion,
			workspaceHash: workspaceStateHash(this.#state.workspace),
			verified: true,
		};
		this.#state.checkpointId = this.#state.checkpoint.id;
		this.#state.readiness = readinessFor(
			this.#state.specification,
			this.#state.workspace,
			this.#state.checkpoint,
			this.#state.plan,
		);
		this.#state.phase =
			this.#state.pendingOperationIds.length > 0 ? "RECOVERING" : carryApproval ? "READY" : "AWAITING_USER";
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowState("plan-updated");
		await this.#publishPlanProjection();
		return cloneState(this.#state).plan;
	}

	async reportObservation(input: Omit<TaskObservation, "id" | "createdAt">): Promise<TaskObservation> {
		if (!this.#state) throw new Error("no active controlled task");
		for (const evidenceId of input.evidenceIds) {
			if (!this.#state.evidence.some(evidence => evidence.id === evidenceId)) {
				throw new Error(`unknown evidence id: ${evidenceId}`);
			}
		}
		const observation: TaskObservation = {
			...input,
			id: this.#mint("observation"),
			evidenceIds: [...input.evidenceIds],
			affects: input.affects.map(affected => ({ ...affected })),
			createdAt: this.#now(),
		};
		this.#state.observations ??= [];
		this.#state.observations.push(observation);
		if (input.kind === "contradiction" || input.kind === "workspace-change") {
			const affectedStepId =
				input.affects.find(affected => affected.type === "step")?.id ??
				this.#state.plan.steps.find(step =>
					(step.assumptionIds ?? []).some(assumptionId =>
						input.affects.some(affected => affected.type === "assumption" && affected.id === assumptionId),
					),
				)?.id ??
				activePlanStep(this.#state.plan)?.id;
			if (affectedStepId) {
				this.#state.reconciliation = {
					stepId: affectedStepId,
					evidenceIds: [...input.evidenceIds],
					classification: input.kind === "workspace-change" ? "environment-changed" : "contradicted-assumption",
					repeatedFailures: 0,
					requiredAction: "patch-plan",
					createdAt: this.#now(),
				};
				this.#state.phase = "RECONCILING";
			}
		}
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("plan-updated");
		await this.#publishPlanProjection();
		return {
			...observation,
			evidenceIds: [...observation.evidenceIds],
			affects: observation.affects.map(a => ({ ...a })),
		};
	}

	async reportStepResult(input: {
		stepId: string;
		status: "completed" | "failed" | "partial" | "progress" | "blocked";
		evidenceIds: string[];
		unexpectedEffects: string[];
		classification?: TaskStepResultClassification;
		observedEffects?: string[];
		contradictedAssumptionIds?: string[];
		changedCondition?: string;
	}): Promise<TaskPlanStep> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) throw new Error("no active controlled task");
		const step = this.#state.plan.steps.find(candidate => candidate.id === input.stepId);
		if (!step) throw new Error(`unknown plan step: ${input.stepId}`);
		if (!stepDependenciesSatisfied(this.#state.plan, step)) {
			throw new Error(`step ${step.id} cannot be reported before its dependencies are completed`);
		}
		const evidence = input.evidenceIds.map(evidenceId => {
			const found = this.#state?.evidence.find(item => item.id === evidenceId);
			if (!found) throw new Error(`unknown evidence id: ${evidenceId}`);
			if (
				found.planStepId !== step.id ||
				found.stale ||
				(found.planVersion !== this.#state?.planVersion && found.stepContractHash !== step.contractHash)
			) {
				throw new Error(`evidence ${evidenceId} is not current evidence for step ${step.id}`);
			}
			return found;
		});
		const classification =
			input.classification ??
			(input.status === "completed" || input.status === "progress" || input.status === "partial"
				? "matched"
				: input.unexpectedEffects.length > 0
					? "unexpected-effect"
					: "execution-failure");
		const completingApprovedPreconditionRecovery =
			isApprovedPreconditionRecovery(this.#state) && this.#state.reconciliation?.stepId === step.id;
		if (input.status === "completed") {
			if (classification !== "matched" || input.unexpectedEffects.length > 0) {
				throw new Error("completed status requires matched classification and no unexpected effects");
			}
			if (isValidationStep(step)) {
				throw new Error("validation steps can only complete through zzw_submit_verification");
			}
			if (evidence.length === 0 || !evidence.some(item => item.outcome !== "failed")) {
				throw new Error(`step ${step.id} requires current operation evidence before completion`);
			}
			step.status = "completed";
			if (this.#state.reconciliation?.stepId === step.id) this.#state.reconciliation = undefined;
			if (!this.#state.reconciliation) {
				this.#state.phase = activePlanStep(this.#state.plan)?.kind === "validation" ? "VERIFYING" : "EXECUTING";
			}
		} else if ((input.status === "partial" || input.status === "progress") && classification === "matched") {
			if (
				completingApprovedPreconditionRecovery &&
				!evidence.some(item => item.type === "tool_result" && item.outcome === "observed")
			) {
				throw new Error(
					"approved precondition recovery requires current successful operation evidence before validation can retry",
				);
			}
			step.status = completingApprovedPreconditionRecovery ? "pending" : "in_progress";
			if (this.#state.reconciliation?.stepId === step.id) this.#state.reconciliation = undefined;
			if (!this.#state.reconciliation) {
				this.#state.phase = completingApprovedPreconditionRecovery ? "READY" : "EXECUTING";
			}
		} else {
			step.status = "blocked";
			const repeatedFailures =
				this.#state.reconciliation?.stepId === step.id ? this.#state.reconciliation.repeatedFailures : 1;
			const routineFeedback =
				(classification === "implementation-feedback" || classification === "missing-precondition") &&
				step.rerunPolicy !== "never" &&
				repeatedFailures < 2 &&
				!this.#state.stalePlan &&
				this.#state.plan.status === "current";
			if (routineFeedback) {
				if (classification === "implementation-feedback" && step.kind !== "work") {
					throw new Error("implementation-feedback can only continue an active work step");
				}
				if (input.unexpectedEffects.length > 0) {
					throw new Error("routine feedback cannot include unexpected side effects");
				}
				if (evidence.length === 0 || !evidence.some(item => item.outcome === "failed")) {
					throw new Error("routine feedback requires current failed operation evidence");
				}
				step.status = "in_progress";
				if (classification === "missing-precondition" && isValidationStep(step)) {
					this.#state.reconciliation = {
						stepId: step.id,
						operationId: this.#state.reconciliation?.operationId,
						evidenceIds: [...input.evidenceIds],
						classification,
						failureFingerprint: this.#state.reconciliation?.failureFingerprint,
						repeatedFailures,
						requiredAction: "satisfy-approved-precondition",
						createdAt: this.#state.reconciliation?.createdAt ?? this.#now(),
					};
					this.#state.phase = "RECONCILING";
				} else {
					this.#state.reconciliation = undefined;
					this.#state.phase = step.kind === "validation" ? "READY" : "EXECUTING";
				}
			} else {
				const executionRetryWindow =
					classification === "execution-failure" && step.rerunPolicy !== "never" && repeatedFailures < 2;
				const changedCondition = input.changedCondition?.trim();
				if (executionRetryWindow && changedCondition) {
					step.status = "pending";
					this.#state.reconciliation = undefined;
					this.#state.phase = "READY";
				} else if (executionRetryWindow) {
					this.#state.reconciliation = {
						stepId: step.id,
						operationId: this.#state.reconciliation?.operationId,
						evidenceIds: [...input.evidenceIds],
						classification,
						failureFingerprint: this.#state.reconciliation?.failureFingerprint,
						repeatedFailures,
						requiredAction: "retry-with-changed-condition",
						createdAt: this.#state.reconciliation?.createdAt ?? this.#now(),
					};
					this.#state.phase = "RECONCILING";
				} else {
					this.#state.stalePlan = true;
					this.#state.plan.status = "stale";
					this.#state.reconciliation = {
						stepId: step.id,
						operationId: this.#state.reconciliation?.operationId,
						evidenceIds: [...input.evidenceIds],
						classification,
						failureFingerprint: this.#state.reconciliation?.failureFingerprint,
						repeatedFailures,
						requiredAction: "patch-plan",
						createdAt: this.#state.reconciliation?.createdAt ?? this.#now(),
					};
					this.#state.phase = "REPLANNING";
				}
			}
		}
		if (input.unexpectedEffects.length > 0 || (input.observedEffects?.length ?? 0) > 0) {
			const observation: TaskObservation = {
				id: this.#mint("observation"),
				kind: input.unexpectedEffects.length > 0 ? "contradiction" : "fact",
				statement: [...(input.observedEffects ?? []), ...input.unexpectedEffects].join("\n"),
				evidenceIds: [...input.evidenceIds],
				confidence: 1,
				affects: [
					{ type: "step", id: step.id },
					...(input.contradictedAssumptionIds ?? []).map(id => ({ type: "assumption" as const, id })),
				],
				createdAt: this.#now(),
			};
			this.#state.observations ??= [];
			this.#state.observations.push(observation);
		}
		this.#state.updatedAt = this.#now();
		this.#state.readiness = readinessFor(
			this.#state.specification,
			this.#state.workspace,
			this.#state.checkpoint,
			this.#state.plan,
		);
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("plan-updated");
		await this.#publishPlanProjection();
		return { ...step, dependsOn: [...step.dependsOn] };
	}

	async submitVerification(input: { stepId: string; evidenceIds: string[] }): Promise<TaskPlanStep> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) throw new Error("no active controlled task");
		const step = this.#state.plan.steps.find(candidate => candidate.id === input.stepId);
		if (!step || !isValidationStep(step)) throw new Error(`unknown validation step: ${input.stepId}`);
		if (!stepDependenciesSatisfied(this.#state.plan, step)) {
			throw new Error(`validation step ${step.id} has incomplete dependencies`);
		}
		const requiredValidators = step.validators ?? [];
		const requiredVerificationIds = step.verificationIds ?? [];
		const evidence = input.evidenceIds.map(evidenceId => {
			const found = this.#state?.evidence.find(item => item.id === evidenceId);
			if (!found) throw new Error(`unknown evidence id: ${evidenceId}`);
			return found;
		});
		const workspaceHash = workspaceStateHash(this.#state.workspace);
		const isCurrentStepEvidence = (item: TaskEvidence): boolean =>
			item.type === "verification" &&
			item.trust === "verified" &&
			item.outcome === "passed" &&
			!item.stale &&
			item.specVersion === this.#state?.specVersion &&
			item.planStepId === step.id &&
			(item.planVersion === this.#state?.planVersion || item.stepContractHash === step.contractHash) &&
			item.workspaceHash === workspaceHash;
		for (const validator of requiredValidators) {
			const valid = evidence.some(item => isCurrentStepEvidence(item) && item.validator === validator);
			if (!valid) throw new Error(`missing current trusted verification evidence for: ${validator}`);
		}
		if (requiredValidators.length === 0) throw new Error(`validation step ${step.id} has no declared validators`);
		for (const verificationId of requiredVerificationIds) {
			const valid = evidence.some(
				item => isCurrentStepEvidence(item) && item.verificationIds?.includes(verificationId) === true,
			);
			if (!valid) {
				throw new Error(`missing current trusted verification evidence for requirement: ${verificationId}`);
			}
		}
		step.status = "completed";
		if (!this.#state.reconciliation) {
			this.#state.phase = unfinishedPlanSteps(this.#state.plan).length === 0 ? "COMPLETING" : "EXECUTING";
		}
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowState("plan-updated");
		await this.#publishPlanProjection();
		return { ...step, dependsOn: [...step.dependsOn] };
	}

	async assertCompletionReady(): Promise<void> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) return;
		const workspace = await this.#captureWorkspace();
		if (!sameWorkspaceState(this.#state.workspace, workspace)) {
			this.#state.workspace = workspace;
			this.#state.workspaceId = workspace.workspaceId;
			this.#state.stalePlan = true;
			this.#state.plan.status = "stale";
			this.#state.evidence = this.#state.evidence.map(item => ({
				...item,
				stale: true,
				staleReason: "workspace-changed",
			}));
			this.#state.phase = "RECOVERING";
			this.#state.updatedAt = this.#now();
			this.#persistState();
			await this.#host.ensureOnDisk();
			await this.#host.flush();
		}
		this.#refreshPendingOperations();
		if (this.#state.pendingOperationIds.length > 0) {
			throw new Error(
				`cannot complete task while operation recovery is pending: ${this.#state.pendingOperationIds.join(", ")}`,
			);
		}
		if (this.#state.stalePlan || this.#state.phase === "RECOVERING" || this.#state.phase === "REPLANNING") {
			throw new Error("cannot complete task until the workspace is reconciled and the stale plan is updated");
		}
		if (this.#state.reconciliation || this.#state.phase === "RECONCILING") {
			throw new Error("Task reconciliation must be resolved before another mutation.");
		}
		if (!this.#state.readiness.ready) {
			const blockers = this.#state.readiness.blockers.map(blocker => blocker.code).join(", ");
			throw new Error(`cannot complete task while readiness blockers remain: ${blockers}`);
		}
		const unfinished = unfinishedPlanSteps(this.#state.plan);
		if (unfinished.length > 0) {
			throw new Error(`cannot complete task while plan steps remain: ${unfinished.map(step => step.id).join(", ")}`);
		}
		const validators = missingValidators(this.#state);
		if (validators.length > 0) {
			throw new Error(`cannot complete task without current verification evidence: ${validators.join(", ")}`);
		}
	}

	async prepareOperation(input: {
		toolCallId: string;
		toolName: string;
		tier: ToolTier;
		args: Record<string, unknown>;
	}): Promise<TaskOperation | undefined> {
		if (!this.#state || input.tier === "read" || TERMINAL_PHASES.has(this.#state.phase)) return undefined;
		const existingId = this.#operationByToolCall.get(input.toolCallId);
		if (existingId) return this.#operations.get(existingId);
		this.#refreshPendingOperations();
		if (this.#state.pendingOperationIds.length > 0) {
			throw new Error(
				`Task recovery is required before another mutation: reconcile prepared operation ${this.#state.pendingOperationIds[0]} with goal({op:"recover", operation_id:"${this.#state.pendingOperationIds[0]}", resolution:"committed"|"failed"|"compensated"}).`,
			);
		}
		const approvedPreconditionRecovery = isApprovedPreconditionRecovery(this.#state);
		if (this.#state.stalePlan || this.#state.phase === "RECOVERING" || this.#state.phase === "REPLANNING") {
			throw new Error(
				"Task plan is stale; propose a minimal ZZWorkflow plan patch before starting another mutation.",
			);
		}
		if ((this.#state.reconciliation || this.#state.phase === "RECONCILING") && !approvedPreconditionRecovery) {
			throw new Error("Task reconciliation must be resolved before another mutation.");
		}
		if (!this.#state.readiness.ready) {
			const blockers = this.#state.readiness.blockers.map(blocker => blocker.code).join(", ");
			throw new Error(
				`Task readiness checks are incomplete (${blockers}); propose and obtain user approval for the ZZWorkflow plan before execution.`,
			);
		}
		if (
			this.#state.phase !== "READY" &&
			this.#state.phase !== "EXECUTING" &&
			this.#state.phase !== "VERIFYING" &&
			!approvedPreconditionRecovery
		) {
			throw new Error(`Task mutations are disabled during ${this.#state.phase}.`);
		}
		if (this.#state.phase === "VERIFYING" && input.tier === "write") {
			throw new Error(
				"Implementation writes are disabled during VERIFYING; return to execution or replanning first.",
			);
		}
		const unassessedDelegationSteps = summarizeDelegation(this.#state.plan).unassessedDelegationStepIds;
		if (
			this.#executionSettings().workUnits.enabled &&
			activePlanSteps(this.#state.plan).length === 0 &&
			unassessedDelegationSteps.length > 0
		) {
			throw new Error(
				`Work Unit 위임 판단이 누락된 pending 단계가 있습니다: ${unassessedDelegationSteps.join(", ")}. 최소 Plan patch로 delegation_assessment를 기록한 뒤 실행하세요.`,
			);
		}
		const activeStep = activePlanStep(this.#state.plan);
		if (!activeStep) throw new Error("No dependency-ready ZZWorkflow plan step is available for this mutation.");
		const allowedTools = effectiveAllowedTools(activeStep);
		if (!allowedTools.includes(input.toolName)) {
			throw new Error(
				`Tool ${input.toolName} is not allowed by active ZZWorkflow step ${activeStep.id}; allowed: ${allowedTools.join(", ") || "none"}.`,
			);
		}
		const target = operationTarget(input.args);
		if (
			target &&
			activeStep.allowedTargets?.length &&
			!activeStep.allowedTargets.some(prefix => target === prefix || target.startsWith(`${prefix}/`))
		) {
			throw new Error(`Target ${target} is outside the allowed targets for ZZWorkflow step ${activeStep.id}.`);
		}
		const validator = matchingValidator(input.toolName, input.args, activeStep);
		if (approvedPreconditionRecovery && validator) {
			throw new Error(
				"Record successful precondition evidence with zzw_report_step_result before rerunning the exact validator.",
			);
		}
		if (isValidationStep(activeStep) && !validator && !approvedPreconditionRecovery) {
			throw new Error(
				`Validation step ${activeStep.id} only permits an exact declared validator command: ${(activeStep.validators ?? []).join(", ")}.`,
			);
		}
		const expectedWorkspace = this.#state.workspace;
		const workspace = await this.#captureWorkspace();
		if (!sameWorkspaceState(expectedWorkspace, workspace)) {
			this.#state.workspace = workspace;
			this.#state.workspaceId = workspace.workspaceId;
			this.#state.stalePlan = true;
			this.#state.plan.status = "stale";
			this.#state.evidence = this.#state.evidence.map(evidence => ({
				...evidence,
				stale: true,
				staleReason: "workspace-changed",
			}));
			this.#state.reconciliation = {
				stepId: activeStep.id,
				evidenceIds: [],
				classification: "environment-changed",
				repeatedFailures: 0,
				requiredAction: "patch-plan",
				createdAt: this.#now(),
			};
			this.#state.phase = "RECONCILING";
			this.#state.updatedAt = this.#now();
			this.#persistState();
			await this.#host.ensureOnDisk();
			await this.#host.flush();
			await this.#syncZZWorkflowState("plan-updated");
			throw new Error(
				"Workspace changed after the current Plan snapshot; reconcile the environment and patch the affected Plan closure before mutation.",
			);
		}
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		await this.#host.assertMutationLease?.(cloneState(this.#state));
		activeStep.status = "in_progress";
		if (!approvedPreconditionRecovery) {
			this.#setPhase(isValidationStep(activeStep) ? "VERIFYING" : "EXECUTING");
		}
		const preStateHash = workspaceStateHash(workspace);
		const operation: TaskOperation = {
			id: this.#mint("operation"),
			taskId: this.#state.taskId,
			attemptId: this.#state.attemptId,
			episodeId: this.#state.episodeId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			tier: input.tier,
			target,
			preStateHash,
			intendedEffect: `Execute the ${input.toolName} tool as part of plan version ${this.#state.planVersion}`,
			idempotencyKey: `${this.#state.taskId}:${this.#state.attemptId}:${this.#state.planVersion}:${input.toolCallId}`,
			checkpointId: this.#state.checkpointId,
			planStepId: activeStep?.id,
			status: "prepared",
			preparedAt: this.#now(),
			evidenceKind: validator ? "verification" : "operation",
			validator,
			verificationIds: validator ? [...(activeStep.verificationIds ?? [])] : [],
			fingerprint: operationFingerprint(input.toolName, input.args, target, preStateHash),
		};
		this.#operations.set(operation.id, operation);
		this.#operationByToolCall.set(operation.toolCallId, operation.id);
		this.#refreshPendingOperations();
		this.#persistOperation(operation);
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-prepared");
		await this.#publishPlanProjection();
		return cloneOperation(operation);
	}

	async settleOperation(toolCallId: string, isError: boolean, result?: unknown): Promise<TaskOperation | undefined> {
		const operationId = this.#operationByToolCall.get(toolCallId);
		if (!operationId) return undefined;
		const operation = this.#operations.get(operationId);
		if (operation?.status !== "prepared") return operation ? cloneOperation(operation) : undefined;
		const workspace = await this.#captureWorkspace();
		const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
		const exitCode = details && typeof details.exitCode === "number" ? details.exitCode : undefined;
		const failed = isError || (exitCode !== undefined && exitCode !== 0);
		operation.status = failed ? "failed" : "committed";
		operation.postStateHash = workspaceStateHash(workspace);
		operation.settledAt = this.#now();
		if (this.#state) {
			const verification = operation.evidenceKind === "verification";
			let resultDigest: string | undefined;
			try {
				resultDigest = lifecycleHash(JSON.stringify({ failed, details: details ?? null }));
			} catch {
				resultDigest = lifecycleHash(String(failed));
			}
			const evidence: TaskEvidence = {
				id: this.#mint("evidence"),
				type: verification ? "verification" : "tool_result",
				summary: `${operation.toolName} ${failed ? "failed" : "completed"}`,
				createdAt: this.#now(),
				workspaceHash: operation.postStateHash,
				stale: false,
				outcome: verification ? (failed ? "failed" : "passed") : failed ? "failed" : "observed",
				validator: operation.validator,
				verificationIds: [...(operation.verificationIds ?? [])],
				specVersion: this.#state.specVersion,
				planVersion: this.#state.planVersion,
				planStepId: operation.planStepId,
				operationId: operation.id,
				toolName: operation.toolName,
				commandFingerprint: operation.validator ? lifecycleHash(operation.validator) : undefined,
				resultDigest,
				exitCode,
				trust: verification && !failed ? "verified" : "raw",
				stepContractHash: this.#state.plan.steps.find(step => step.id === operation.planStepId)?.contractHash,
			};
			operation.evidenceId = evidence.id;
			this.#state.evidence.push(evidence);
			this.#state.workspace = workspace;
			this.#state.workspaceId = workspace.workspaceId;
			if (failed && operation.planStepId) {
				const failedStep = this.#state.plan.steps.find(step => step.id === operation.planStepId);
				if (failedStep) failedStep.status = "blocked";
				const repeatedFailures = [...this.#operations.values()].filter(
					candidate =>
						candidate.status === "failed" &&
						candidate.planStepId === operation.planStepId &&
						candidate.fingerprint === operation.fingerprint,
				).length;
				this.#state.reconciliation = {
					stepId: operation.planStepId,
					operationId: operation.id,
					evidenceIds: [evidence.id],
					classification: verification ? "verification-failure" : undefined,
					failureFingerprint: operation.fingerprint,
					repeatedFailures,
					requiredAction: repeatedFailures >= 2 ? "patch-plan" : "classify-result",
					createdAt: this.#now(),
				};
				this.#state.phase = "RECONCILING";
			}
			this.#state.readiness = readinessFor(
				this.#state.specification,
				this.#state.workspace,
				this.#state.checkpoint,
				this.#state.plan,
			);
			this.#refreshPendingOperations();
			this.#state.updatedAt = this.#now();
		}
		this.#persistOperation(operation);
		this.#persistState();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-settled");
		await this.#publishPlanProjection();
		return cloneOperation(operation);
	}

	async resolveOperation(
		operationId: string,
		resolution: Extract<TaskOperationStatus, "committed" | "failed" | "compensated">,
	): Promise<TaskOperation> {
		const operation = this.#operations.get(operationId);
		if (!operation) throw new Error(`unknown task operation ${operationId}`);
		if (operation.status !== "prepared" && operation.status !== "running" && operation.status !== "unknown") {
			throw new Error(`task operation ${operationId} is already ${operation.status}`);
		}
		const workspace = await this.#captureWorkspace();
		operation.status = resolution;
		operation.postStateHash = workspaceStateHash(workspace);
		operation.settledAt = this.#now();
		operation.recoveryNote = `Manually reconciled as ${resolution}`;
		if (this.#state) {
			const evidence: TaskEvidence = {
				id: this.#mint("evidence"),
				type: "workspace",
				summary: `${operation.toolName} was manually reconciled as ${resolution}`,
				createdAt: this.#now(),
				workspaceHash: operation.postStateHash,
				stale: false,
				outcome: "observed",
				specVersion: this.#state.specVersion,
				planVersion: this.#state.planVersion,
				planStepId: operation.planStepId,
				operationId: operation.id,
				toolName: operation.toolName,
				trust: "raw",
				stepContractHash: this.#state.plan.steps.find(step => step.id === operation.planStepId)?.contractHash,
			};
			operation.evidenceId = evidence.id;
			this.#state.evidence.push(evidence);
			this.#state.workspace = workspace;
			this.#state.workspaceId = workspace.workspaceId;
			const lane = this.#state.execution.lanes.find(
				candidate => candidate.id === operation.laneId || candidate.operationIds.includes(operation.id),
			);
			if (lane) {
				lane.evidenceIds.push(evidence.id);
				const laneOperations = lane.operationIds.flatMap(id => {
					const candidate = this.#operations.get(id);
					return candidate ? [candidate] : [];
				});
				if (
					laneOperations.every(candidate =>
						["committed", "failed", "cancelled", "interrupted", "compensated"].includes(candidate.status),
					)
				) {
					if (operation.toolName === "zzw-integrate") {
						lane.status = resolution === "committed" ? "integrated" : "rejected";
					} else if (resolution === "committed") {
						lane.status = lane.executor === "subagent-isolated" ? "interrupted" : "succeeded";
						if (lane.executor === "subagent-isolated") {
							lane.error = "Recovered isolated execution has no trustworthy automatic integration continuation.";
						}
					} else {
						lane.status = "failed";
					}
					lane.settledAt = this.#now();
				}
				const wave = this.#state.execution.waves.find(candidate => candidate.id === lane.waveId);
				if (wave) this.#updateExecutionWave(wave, this.#now());
			}
			this.#refreshPendingOperations();
			if (this.#state.pendingOperationIds.length === 0 && operation.planStepId) {
				const step = this.#state.plan.steps.find(candidate => candidate.id === operation.planStepId);
				const laneNeedsRecovery =
					lane !== undefined && ["failed", "interrupted", "unknown", "rejected"].includes(lane.status);
				if (step) step.status = resolution === "committed" && !laneNeedsRecovery ? "in_progress" : "blocked";
				this.#state.reconciliation = {
					stepId: operation.planStepId,
					operationId: operation.id,
					evidenceIds: [evidence.id],
					classification: resolution === "committed" && !laneNeedsRecovery ? undefined : "execution-failure",
					failureFingerprint: operation.fingerprint,
					repeatedFailures: resolution === "failed" ? 1 : 0,
					requiredAction: "classify-result",
					createdAt: this.#now(),
				};
				this.#state.phase = "RECONCILING";
			}
			this.#state.updatedAt = this.#now();
		}
		this.#persistOperation(operation);
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncZZWorkflowOperation(operation, "operation-reconciled");
		await this.#recallKnowledge("recovery");
		return cloneOperation(operation);
	}

	buildContext(): string | undefined {
		if (!this.#state) return undefined;
		const executionSettings = this.#executionSettings();
		const executionMode = executionSettings.mode;
		const delegation = summarizeDelegation(this.#state.plan);
		const currentVerification = missingValidators(this.#state).length === 0;
		const stateDigest = lifecycleHash(
			JSON.stringify({
				taskId: this.#state.taskId,
				specVersion: this.#state.specVersion,
				planVersion: this.#state.planVersion,
				phase: this.#state.phase,
				workspace: workspaceStateHash(this.#state.workspace),
				pendingOperationIds: this.#state.pendingOperationIds,
				execution: this.#state.execution,
				executionSettings,
				delegation,
				reconciliation: this.#state.reconciliation,
				readiness: this.#state.readiness.ready,
				verification: currentVerification,
			}),
		);
		const pendingOperations = this.#state.pendingOperationIds.map(id => {
			const operation = this.#operations.get(id);
			return {
				id: escapeXmlText(id),
				toolName: escapeXmlText(operation?.toolName ?? "unknown"),
				target: operation?.target ? escapeXmlText(operation.target) : undefined,
			};
		});
		const activeStep = activePlanStep(this.#state.plan);
		const activeWave = this.#state.execution.activeWaveId
			? this.#state.execution.waves.find(wave => wave.id === this.#state?.execution.activeWaveId)
			: undefined;
		const milestone = readyMilestone(this.#state.plan);
		return prompt.render(taskLifecycleContextPrompt, {
			contextVersion: String(this.#state.updatedAt),
			stateDigest,
			taskId: escapeXmlText(this.#state.taskId),
			attemptId: escapeXmlText(this.#state.attemptId),
			sessionId: escapeXmlText(this.#state.sessionId),
			episodeId: escapeXmlText(this.#state.episodeId),
			workspaceId: escapeXmlText(this.#state.workspaceId),
			specVersion: String(this.#state.specVersion),
			planVersion: String(this.#state.planVersion),
			planApproval: this.#state.plan.approval ?? "draft",
			checkpointId: escapeXmlText(this.#state.checkpointId),
			phase: this.#state.phase,
			requiredNextAction: nextRequiredAction(this.#state, executionMode, executionSettings.workUnits.enabled),
			executionMode,
			validationConcurrency: String(executionSettings.validationConcurrency),
			subagentConcurrency: String(executionSettings.subagentConcurrency),
			workUnitsEnabled: String(executionSettings.workUnits.enabled),
			workUnitModel: escapeXmlText(executionSettings.workUnits.model),
			delegationAssessmentRequired: String(executionSettings.workUnits.enabled),
			adversarialReviewEnabled: String(executionSettings.adversarialReview.enabled),
			adversarialReviewerModel: escapeXmlText(executionSettings.adversarialReview.model),
			delegatedStepCount: String(delegation.delegatedStepIds.length),
			retainedPrimaryStepCount: String(delegation.retainedPrimaryStepIds.length),
			unassessedDelegationStepCount: String(delegation.unassessedDelegationStepIds.length),
			declaredWorkUnitCount: String(delegation.declaredWorkUnitCount),
			writesAllowed: String(writesAllowed(this.#state, executionSettings.workUnits.enabled)),
			verificationFresh: String(currentVerification),
			workspaceBranch: escapeXmlText(this.#state.workspace.branch ?? "detached"),
			workspaceHead: escapeXmlText(this.#state.workspace.headCommit ?? "unavailable"),
			workspaceDirty: String(this.#state.workspace.dirtyTreeHash !== null),
			hasReadinessBlockers: this.#state.readiness.blockers.length > 0,
			readinessBlockers: this.#state.readiness.blockers.map(blocker => ({
				code: blocker.code,
				message: escapeXmlText(blocker.message),
			})),
			stalePlan: this.#state.stalePlan,
			activePlanStep: activeStep
				? {
						...activeStep,
						id: escapeXmlText(activeStep.id),
						content: escapeXmlText(activeStep.content),
					}
				: undefined,
			hasActiveWave: activeWave !== undefined,
			activeWave: activeWave
				? {
						id: escapeXmlText(activeWave.id),
						status: activeWave.status,
						lanes: activeWave.laneIds.flatMap(id => {
							const lane = this.#state?.execution.lanes.find(candidate => candidate.id === id);
							return lane
								? [
										{
											id: escapeXmlText(lane.id),
											stepId: escapeXmlText(lane.stepId),
											executor: lane.executor,
											status: lane.status,
											planImpactLevel:
												lane.planImpact?.level === "none" ? undefined : lane.planImpact?.level,
											planImpactKind: lane.planImpact?.level === "none" ? undefined : lane.planImpact?.kind,
										},
									]
								: [];
						}),
					}
				: undefined,
			readyMilestone: milestone
				? { id: escapeXmlText(milestone.id), content: escapeXmlText(milestone.content) }
				: undefined,
			reconciliation: this.#state.reconciliation
				? {
						...this.#state.reconciliation,
						stepId: escapeXmlText(this.#state.reconciliation.stepId),
						classification: this.#state.reconciliation.classification ?? "unclassified",
						planImpact: this.#state.reconciliation.planImpact
							? {
									...this.#state.reconciliation.planImpact,
									reason: escapeXmlText(this.#state.reconciliation.planImpact.reason),
								}
							: undefined,
					}
				: undefined,
			hasPendingOperations: pendingOperations.length > 0,
			pendingOperations,
			knowledgeWorkingSet: this.#knowledgeWorkingSet,
		});
	}
}
