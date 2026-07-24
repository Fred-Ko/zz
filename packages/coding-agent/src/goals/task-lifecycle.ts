import * as path from "node:path";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { escapeXmlText, isEnoent, isRecord, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import taskLifecycleContextPrompt from "../prompts/goals/task-lifecycle-context.md" with { type: "text" };
import taskLifecycleMemoryPrompt from "../prompts/goals/task-lifecycle-memory.md" with { type: "text" };
import * as git from "../utils/git";
import { resolveRepositoryIdentity } from "../workflow/identity";
import type { Goal } from "./state";

export const TASK_LIFECYCLE_ENTRY_TYPE = "task-lifecycle";
export const TASK_OPERATION_ENTRY_TYPE = "task-operation";
export const TASK_LIFECYCLE_SCHEMA_VERSION = 1;

export type TaskLifecyclePhase =
	| "INTAKE"
	| "DISCOVERY"
	| "SPECIFICATION"
	| "PREPARATION"
	| "READY"
	| "EXECUTING"
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

export interface TaskSpecification {
	version: number;
	goal: string;
	successConditions: string[];
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
	| "CHECKPOINT_MISSING";

export interface TaskReadinessBlocker {
	code: TaskReadinessBlockerCode;
	message: string;
}

export type TaskPlanStepStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type TaskPlanStepKind = "work" | "validation" | "acceptance";

export interface TaskPlanStep {
	id: string;
	phase: string;
	content: string;
	status: TaskPlanStepStatus;
	dependsOn: string[];
	kind?: TaskPlanStepKind;
}

export interface TaskPlan {
	version: number;
	status: "current" | "stale";
	steps: TaskPlanStep[];
}

export interface TaskPlanPhaseInput {
	name: string;
	tasks: Array<{
		content: string;
		status: TaskPlanStepStatus;
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
	specVersion?: number;
}

export type TaskOperationStatus = "prepared" | "running" | "committed" | "failed" | "compensated";

export interface TaskOperation {
	id: string;
	taskId: string;
	attemptId: string;
	episodeId: string;
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
	pendingOperationIds: string[];
	stalePlan: boolean;
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
	readinessReady: boolean;
	readinessBlockers: TaskReadinessBlockerCode[];
	verificationFresh: boolean;
	writesAllowed: boolean;
	requiredNextAction: string;
	workspaceHead: string | null;
}

export interface TaskLifecycleHandoff {
	state: TaskLifecycleState;
	operations: TaskOperation[];
}

export interface TaskLifecycleMemory {
	content: string;
	context: string;
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
	syncSharedState?(
		state: TaskLifecycleState,
		reason:
			| "created"
			| "replaced"
			| "revised"
			| "episode-started"
			| "plan-updated"
			| "paused"
			| "handoff"
			| "completed"
			| "abandoned",
	): Promise<void>;
	syncSharedOperation?(
		state: TaskLifecycleState,
		operation: TaskOperation,
		reason: "operation-prepared" | "operation-settled" | "operation-reconciled",
	): Promise<void>;
	assertMutationLease?(state: TaskLifecycleState): Promise<void>;
	recallTaskMemory?(state: TaskLifecycleState, stage: "intake" | "planning" | "recovery"): Promise<string | undefined>;
	retainTaskMemory?(memory: TaskLifecycleMemory, state: TaskLifecycleState): Promise<void> | void;
	now?(): number;
	mintId?(kind: "attempt" | "episode" | "checkpoint" | "evidence" | "operation" | "statement"): string;
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
const LIFECYCLE_PHASES = new Set<string>([
	"INTAKE",
	"DISCOVERY",
	"SPECIFICATION",
	"PREPARATION",
	"READY",
	"EXECUTING",
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
const OPERATION_STATUSES = new Set<string>(["prepared", "running", "committed", "failed", "compensated"]);
const PLAN_STEP_STATUSES = new Set<string>(["pending", "in_progress", "completed", "abandoned", "blocked"]);
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

function cloneWorkspace(workspace: TaskWorkspaceSnapshot): TaskWorkspaceSnapshot {
	return { ...workspace };
}

function cloneOperation(operation: TaskOperation): TaskOperation {
	return { ...operation };
}

function cloneState(state: TaskLifecycleState): TaskLifecycleState {
	return {
		...state,
		specification: {
			...state.specification,
			successConditions: [...state.specification.successConditions],
			verification: [...state.specification.verification],
			verificationExplicit:
				state.specification.verificationExplicit ??
				state.specification.verification.some(item => item !== "Manual user review of the stated objective"),
			scope: [...state.specification.scope],
			outOfScope: [...state.specification.outOfScope],
			constraints: [...state.specification.constraints],
			statements: state.specification.statements.map(statement => ({ ...statement })),
		},
		workspace: cloneWorkspace(state.workspace),
		readiness: {
			...state.readiness,
			blockers: (state.readiness.blockers ?? []).map(blocker => ({ ...blocker })),
		},
		plan: {
			...state.plan,
			steps: state.plan.steps.map(step => ({ ...step, dependsOn: [...step.dependsOn] })),
		},
		checkpoint: { ...state.checkpoint },
		episode: { ...state.episode, startWorkspace: cloneWorkspace(state.episode.startWorkspace) },
		evidence: state.evidence.map(item => ({ ...item })),
		pendingOperationIds: [...state.pendingOperationIds],
		handoff: state.handoff
			? {
					...state.handoff,
					workspace: cloneWorkspace(state.handoff.workspace),
					pendingOperationIds: [...state.handoff.pendingOperationIds],
					staleEvidenceIds: [...state.handoff.staleEvidenceIds],
					plan: {
						...state.handoff.plan,
						steps: state.handoff.plan.steps.map(step => ({ ...step, dependsOn: [...step.dependsOn] })),
					},
				}
			: undefined,
	};
}

export function summarizeTaskLifecycle(state: TaskLifecycleState | undefined): TaskLifecycleSummary | null {
	if (!state) return null;
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
		activePlanStepId: activePlanStep(state.plan)?.id,
		readinessReady: state.readiness.ready,
		readinessBlockers: state.readiness.blockers.map(blocker => blocker.code),
		verificationFresh: missingValidators(state).length === 0,
		writesAllowed: writesAllowed(state),
		requiredNextAction: nextRequiredAction(state),
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
	const acceptanceSteps = specification.successConditions.map((content, index) => {
		const id = planStepId("Acceptance", content, index);
		return {
			id,
			phase: "Acceptance",
			content,
			status: "pending",
			dependsOn: [],
			kind: "acceptance",
		} satisfies TaskPlanStep;
	});
	const verificationSteps = specification.verification.map((content, index) => {
		return {
			id: planStepId("Verification", content, acceptanceSteps.length + index),
			phase: "Verification",
			content,
			status: "pending",
			dependsOn: acceptanceSteps.map(step => step.id),
			kind: "validation",
		} satisfies TaskPlanStep;
	});
	return { version, status: "current", steps: [...acceptanceSteps, ...verificationSteps] };
}

function planFromPhases(phases: readonly TaskPlanPhaseInput[], version: number): TaskPlan {
	let previousPhaseStepIds: string[] = [];
	let index = 0;
	const steps: TaskPlanStep[] = [];
	for (const phase of phases) {
		const phaseSteps = phase.tasks.map(task => {
			const step: TaskPlanStep = {
				id: planStepId(phase.name, task.content, index++),
				phase: phase.name,
				content: task.content,
				status: task.status,
				dependsOn: [...previousPhaseStepIds],
				kind: planStepKind(phase.name, task.content),
			};
			return step;
		});
		steps.push(...phaseSteps);
		previousPhaseStepIds = phaseSteps.filter(step => step.status !== "abandoned").map(step => step.id);
	}
	return { version, status: "current", steps };
}

function matchingValidator(
	args: Record<string, unknown>,
	specification: TaskSpecification,
	activeStep: TaskPlanStep | undefined,
): string | undefined {
	const command = typeof args.command === "string" ? args.command.trim() : undefined;
	if (command) {
		const normalizedCommand = command.replace(/\s+/g, " ");
		const exact = specification.verification.find(
			validator => validator.trim().replace(/\s+/g, " ") === normalizedCommand,
		);
		if (exact) return exact;
	}
	if (activeStep && isValidationStep(activeStep)) return activeStep.content;
	return undefined;
}

function freshVerificationEvidence(state: TaskLifecycleState): TaskEvidence[] {
	const currentWorkspaceHash = workspaceStateHash(state.workspace);
	return state.evidence.filter(
		evidence =>
			evidence.type === "verification" &&
			evidence.outcome === "passed" &&
			!evidence.stale &&
			evidence.specVersion === state.specVersion &&
			evidence.workspaceHash === currentWorkspaceHash,
	);
}

function missingValidators(state: TaskLifecycleState): string[] {
	const evidence = freshVerificationEvidence(state);
	if (!state.specification.verificationExplicit) {
		return evidence.length > 0 ? [] : ["A current validation step"];
	}
	return state.specification.verification.filter(validator => !evidence.some(item => item.validator === validator));
}

function nextRequiredAction(state: TaskLifecycleState): string {
	if (state.pendingOperationIds.length > 0) return "reconcile_pending_operation";
	if (state.stalePlan || state.phase === "RECOVERING" || state.phase === "REPLANNING") {
		return "reconcile_workspace_and_update_plan";
	}
	if (!state.readiness.ready) return "resolve_readiness_blockers";
	if (missingValidators(state).length > 0) return "run_required_validation";
	return "execute_active_step";
}

function writesAllowed(state: TaskLifecycleState): boolean {
	return (
		state.readiness.ready &&
		!state.stalePlan &&
		state.pendingOperationIds.length === 0 &&
		(state.phase === "READY" || state.phase === "EXECUTING")
	);
}

function planSignature(plan: TaskPlan): string {
	return JSON.stringify(plan.steps.map(step => [step.phase, step.content, step.status, step.dependsOn, step.kind]));
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

function activePlanStep(plan: TaskPlan): TaskPlanStep | undefined {
	return (
		plan.steps.find(step => step.status === "in_progress") ??
		plan.steps.find(step => step.status === "pending" || step.status === "blocked")
	);
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
		successConditions: resolvedSuccess,
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
	const planDefinesValidation = plan.steps.some(
		step => isValidationStep(step) && !specification.verification.includes(step.content),
	);
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
				Array.isArray(step.dependsOn),
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
		Array.isArray(value.specification.verification) &&
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
		Array.isArray(value.pendingOperationIds) &&
		(value.handoff === undefined ||
			(isRecord(value.handoff) &&
				isRecord(value.handoff.workspace) &&
				isTaskPlan(value.handoff.plan) &&
				Array.isArray(value.handoff.pendingOperationIds) &&
				Array.isArray(value.handoff.staleEvidenceIds)))
	);
}

function lifecycleStateFromEntry(entry: TaskLifecycleJournalEntry): TaskLifecycleState | undefined {
	if (entry.type !== "custom" || entry.customType !== TASK_LIFECYCLE_ENTRY_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	if (entry.data.schemaVersion !== TASK_LIFECYCLE_SCHEMA_VERSION || entry.data.kind !== "snapshot") return undefined;
	return isLifecycleState(entry.data.state) ? cloneState(entry.data.state) : undefined;
}

function isTaskOperation(value: unknown): value is TaskOperation {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.taskId === "string" &&
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
	if (entry.data.schemaVersion !== TASK_LIFECYCLE_SCHEMA_VERSION || entry.data.kind !== "operation") return undefined;
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

export class TaskLifecycleRuntime {
	readonly #host: TaskLifecycleHost;
	#state: TaskLifecycleState | undefined;
	readonly #operations = new Map<string, TaskOperation>();
	readonly #operationByToolCall = new Map<string, string>();
	#memoryContext: string | undefined;

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

	async #syncSharedState(reason: Parameters<NonNullable<TaskLifecycleHost["syncSharedState"]>>[1]): Promise<void> {
		if (!this.#state) return;
		await this.#host.syncSharedState?.(cloneState(this.#state), reason);
	}

	async #syncSharedOperation(
		operation: TaskOperation,
		reason: Parameters<NonNullable<TaskLifecycleHost["syncSharedOperation"]>>[2],
	): Promise<void> {
		if (!this.#state) return;
		await this.#host.syncSharedOperation?.(cloneState(this.#state), cloneOperation(operation), reason);
	}

	async #recallMemory(stage: "intake" | "planning" | "recovery"): Promise<void> {
		if (!this.#state) return;
		this.#memoryContext = await this.#host.recallTaskMemory?.(cloneState(this.#state), stage);
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
			.filter(operation => operation.taskId === this.#state?.taskId && operation.status === "prepared")
			.map(operation => operation.id);
	}

	rehydrate(): void {
		this.#state = undefined;
		this.#operations.clear();
		this.#operationByToolCall.clear();
		for (const entry of this.#host.getEntries()) {
			const state = lifecycleStateFromEntry(entry);
			if (state) this.#state = state;
			const operation = operationFromEntry(entry);
			if (!operation) continue;
			this.#operations.set(operation.id, operation);
			this.#operationByToolCall.set(operation.toolCallId, operation.id);
		}
		if (this.#state) {
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
		this.#memoryContext = undefined;
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
			pendingOperationIds: [],
			stalePlan: false,
			createdAt: now,
			updatedAt: now,
		};
		this.#persistState();
		for (const phase of ["DISCOVERY", "SPECIFICATION", "PREPARATION"] as const) {
			this.#setPhase(phase);
		}
		if (this.#state.readiness.ready) this.#setPhase("READY");
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncSharedState("created");
		await this.#recallMemory("intake");
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
			this.#state.evidence = this.#state.evidence.map(item => ({ ...item, stale: true }));
			this.#state.phase = "RECOVERING";
		} else {
			this.#state.phase = active ? (this.#state.readiness.ready ? "READY" : "PREPARATION") : "SUSPENDED";
		}
		this.#refreshPendingOperations();
		if (this.#state.pendingOperationIds.length > 0) this.#state.phase = "RECOVERING";
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncSharedState("episode-started");
		await this.#recallMemory(
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
		await this.#syncSharedState("handoff");
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
		await this.#syncSharedState("paused");
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
				await this.#syncSharedState("replaced");
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
				this.#state.planVersion++;
				this.#state.specification = specificationFromGoal(
					event.goal,
					this.#host.getSessionId(),
					this.#state.specVersion,
					() => this.#mint("statement"),
				);
				this.#state.stalePlan = true;
				this.#state.plan.version = this.#state.planVersion;
				this.#state.plan.status = "stale";
				this.#state.evidence = this.#state.evidence.map(item => ({ ...item, stale: true }));
				this.#state.phase = "REPLANNING";
				this.#state.updatedAt = this.#now();
				this.#persistState();
				await this.#host.ensureOnDisk();
				await this.#host.flush();
				await this.#syncSharedState("revised");
				await this.#recallMemory("planning");
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
				const retainedStatements = this.#state.specification.statements.filter(
					statement =>
						statement.type === "confirmed_requirement" ||
						statement.type === "user_preference" ||
						statement.type === "rejected_option",
				);
				if (retainedStatements.length > 0) {
					await this.#host.retainTaskMemory?.(
						{
							content: prompt.render(taskLifecycleMemoryPrompt, {
								goal: this.#state.specification.goal,
								taskId: this.#state.taskId,
								attemptId: this.#state.attemptId,
								specVersion: String(this.#state.specVersion),
								planVersion: String(this.#state.planVersion),
								statements: retainedStatements,
							}),
							context: "Verified coding task outcome",
						},
						cloneState(this.#state),
					);
				}
				await this.#syncSharedState("completed");
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
				await this.#syncSharedState("abandoned");
		}
	}

	async syncPlan(phases: readonly TaskPlanPhaseInput[]): Promise<void> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) return;
		const nextPlan = planFromPhases(phases, this.#state.planVersion + 1);
		if (planSignature(this.#state.plan) === planSignature(nextPlan) && !this.#state.stalePlan) return;
		this.#state.planVersion = nextPlan.version;
		this.#state.plan = nextPlan;
		this.#state.stalePlan = false;
		const checkpoint: TaskCheckpoint = {
			id: this.#mint("checkpoint"),
			createdAt: this.#now(),
			phase: "PREPARATION",
			planVersion: nextPlan.version,
			workspaceHash: workspaceStateHash(this.#state.workspace),
			verified: true,
		};
		this.#state.checkpoint = checkpoint;
		this.#state.checkpointId = checkpoint.id;
		this.#state.readiness = readinessFor(this.#state.specification, this.#state.workspace, checkpoint, nextPlan);
		this.#refreshPendingOperations();
		this.#state.phase =
			this.#state.pendingOperationIds.length > 0
				? "RECOVERING"
				: this.#state.readiness.ready
					? "READY"
					: "PREPARATION";
		this.#state.updatedAt = this.#now();
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncSharedState("plan-updated");
		await this.#recallMemory("planning");
	}

	async assertCompletionReady(): Promise<void> {
		if (!this.#state || TERMINAL_PHASES.has(this.#state.phase)) return;
		const workspace = await this.#captureWorkspace();
		if (!sameWorkspaceState(this.#state.workspace, workspace)) {
			this.#state.workspace = workspace;
			this.#state.workspaceId = workspace.workspaceId;
			this.#state.stalePlan = true;
			this.#state.plan.status = "stale";
			this.#state.evidence = this.#state.evidence.map(item => ({ ...item, stale: true }));
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
		if (!this.#state.readiness.ready) {
			const blockers = this.#state.readiness.blockers.map(blocker => blocker.code).join(", ");
			throw new Error(`cannot complete task while readiness blockers remain: ${blockers}`);
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
		if (
			input.toolName !== "todo" &&
			(this.#state.stalePlan || this.#state.phase === "RECOVERING" || this.#state.phase === "REPLANNING")
		) {
			throw new Error("Task plan is stale; update the persisted todo plan before starting another mutation.");
		}
		if (input.toolName !== "todo" && !this.#state.readiness.ready) {
			const blockers = this.#state.readiness.blockers.map(blocker => blocker.code).join(", ");
			throw new Error(
				`Task readiness checks are incomplete (${blockers}); update the task contract or persisted todo plan before execution.`,
			);
		}
		if (
			input.toolName !== "todo" &&
			this.#state.phase !== "READY" &&
			this.#state.phase !== "EXECUTING" &&
			this.#state.phase !== "VERIFYING"
		) {
			throw new Error(`Task mutations are disabled during ${this.#state.phase}.`);
		}
		if (input.toolName !== "todo" && this.#state.phase === "VERIFYING" && input.tier === "write") {
			throw new Error(
				"Implementation writes are disabled during VERIFYING; return to execution or replanning first.",
			);
		}
		await this.#host.assertMutationLease?.(cloneState(this.#state));
		const workspace = await this.#captureWorkspace();
		this.#state.workspace = workspace;
		this.#state.workspaceId = workspace.workspaceId;
		this.#setPhase("EXECUTING");
		const activeStep = activePlanStep(this.#state.plan);
		const validator = matchingValidator(input.args, this.#state.specification, activeStep);
		const operation: TaskOperation = {
			id: this.#mint("operation"),
			taskId: this.#state.taskId,
			attemptId: this.#state.attemptId,
			episodeId: this.#state.episodeId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			tier: input.tier,
			target: operationTarget(input.args),
			preStateHash: workspaceStateHash(workspace),
			intendedEffect: `Execute the ${input.toolName} tool as part of plan version ${this.#state.planVersion}`,
			idempotencyKey: `${this.#state.taskId}:${this.#state.attemptId}:${this.#state.planVersion}:${input.toolCallId}`,
			checkpointId: this.#state.checkpointId,
			planStepId: activeStep?.id,
			status: "prepared",
			preparedAt: this.#now(),
			evidenceKind: validator ? "verification" : "operation",
			validator,
		};
		this.#operations.set(operation.id, operation);
		this.#operationByToolCall.set(operation.toolCallId, operation.id);
		this.#refreshPendingOperations();
		this.#persistOperation(operation);
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncSharedOperation(operation, "operation-prepared");
		return cloneOperation(operation);
	}

	async settleOperation(toolCallId: string, isError: boolean): Promise<TaskOperation | undefined> {
		const operationId = this.#operationByToolCall.get(toolCallId);
		if (!operationId) return undefined;
		const operation = this.#operations.get(operationId);
		if (operation?.status !== "prepared") return operation ? cloneOperation(operation) : undefined;
		const workspace = await this.#captureWorkspace();
		operation.status = isError ? "failed" : "committed";
		operation.postStateHash = workspaceStateHash(workspace);
		operation.settledAt = this.#now();
		if (this.#state) {
			const verification = operation.evidenceKind === "verification";
			const evidence: TaskEvidence = {
				id: this.#mint("evidence"),
				type: verification ? "verification" : "tool_result",
				summary: `${operation.toolName} ${isError ? "failed" : "completed"}`,
				createdAt: this.#now(),
				workspaceHash: operation.postStateHash,
				stale: false,
				outcome: verification ? (isError ? "failed" : "passed") : isError ? "failed" : "observed",
				validator: operation.validator,
				specVersion: this.#state.specVersion,
			};
			operation.evidenceId = evidence.id;
			this.#state.evidence.push(evidence);
			this.#state.workspace = workspace;
			this.#state.workspaceId = workspace.workspaceId;
			this.#refreshPendingOperations();
			this.#state.updatedAt = this.#now();
		}
		this.#persistOperation(operation);
		this.#persistState();
		await this.#host.flush();
		await this.#syncSharedOperation(operation, "operation-settled");
		return cloneOperation(operation);
	}

	async resolveOperation(
		operationId: string,
		resolution: Extract<TaskOperationStatus, "committed" | "failed" | "compensated">,
	): Promise<TaskOperation> {
		const operation = this.#operations.get(operationId);
		if (!operation) throw new Error(`unknown task operation ${operationId}`);
		if (operation.status !== "prepared") {
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
			};
			operation.evidenceId = evidence.id;
			this.#state.evidence.push(evidence);
			this.#state.workspace = workspace;
			this.#state.workspaceId = workspace.workspaceId;
			this.#refreshPendingOperations();
			if (this.#state.pendingOperationIds.length === 0) {
				this.#state.phase = "REPLANNING";
				this.#state.stalePlan = true;
				this.#state.plan.status = "stale";
			}
			this.#state.updatedAt = this.#now();
		}
		this.#persistOperation(operation);
		this.#persistState();
		await this.#host.ensureOnDisk();
		await this.#host.flush();
		await this.#syncSharedOperation(operation, "operation-reconciled");
		await this.#recallMemory("recovery");
		return cloneOperation(operation);
	}

	buildContext(): string | undefined {
		if (!this.#state) return undefined;
		const currentVerification = missingValidators(this.#state).length === 0;
		const stateDigest = lifecycleHash(
			JSON.stringify({
				taskId: this.#state.taskId,
				specVersion: this.#state.specVersion,
				planVersion: this.#state.planVersion,
				phase: this.#state.phase,
				workspace: workspaceStateHash(this.#state.workspace),
				pendingOperationIds: this.#state.pendingOperationIds,
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
			checkpointId: escapeXmlText(this.#state.checkpointId),
			phase: this.#state.phase,
			requiredNextAction: nextRequiredAction(this.#state),
			writesAllowed: String(writesAllowed(this.#state)),
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
			hasPendingOperations: pendingOperations.length > 0,
			pendingOperations,
			memoryContext: this.#memoryContext,
		});
	}
}
