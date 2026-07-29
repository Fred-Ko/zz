import { prompt } from "@oh-my-pi/pi-utils";
import { executeBash } from "../../exec/bash-executor";
import type { TaskLifecycleRuntime, TaskPlanStep, TaskPreparedExecutionWave } from "../../goals/task-lifecycle";
import zzwAdversarialReviewPrompt from "../../prompts/goals/zzw-adversarial-review.md" with { type: "text" };
import zzwExecutionLanePrompt from "../../prompts/goals/zzw-execution-lane.md" with { type: "text" };
import {
	type IsolationContext,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runInIsolatedWorkspace,
} from "../../task/isolation-runner";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "../../task/parallel";
import { runStructuredSubagent, type StructuredSubagentResult } from "../../task/structured-subagent";
import { getRepoRoot, patchTouchedFiles } from "../../task/worktree";
import type { ToolSession } from "../../tools";
import { resourceKeysOverlap, ZZWResourceClaimLock } from "./resource-claims";
import { effectiveStepExecution } from "./scheduler";
import {
	selectZZWExecutionOutcomeLanes,
	type ZZWExecutionLane,
	type ZZWExecutionSettings,
	type ZZWPlanImpact,
	type ZZWPlanImpactKind,
	type ZZWWorkUnitContract,
} from "./types";

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "lsp", "ast_grep", "web_search"]);
const CONTROLLER_TOOLS = new Set(["ask", "goal", "hub", "manage_skill", "task", "todo", "yield"]);

const PLAN_IMPACT_SCHEMA = {
	type: "object",
	required: [
		"level",
		"kind",
		"reason",
		"evidence",
		"affected_step_ids",
		"contradicted_assumption_ids",
		"proposed_changes",
	],
	properties: {
		level: { type: "string", enum: ["none", "execution", "structural", "contract"] },
		kind: {
			type: "string",
			enum: [
				"none",
				"implementation-feedback",
				"missing-precondition",
				"execution-failure",
				"contradicted-precondition",
				"contradicted-assumption",
				"unexpected-effect",
				"missing-step",
				"dependency-change",
				"resource-change",
				"validation-change",
				"scope-change",
				"risk-change",
				"contract-decision",
			],
		},
		reason: { type: "string" },
		evidence: { type: "array", items: { type: "string" } },
		affected_step_ids: { type: "array", items: { type: "string" } },
		contradicted_assumption_ids: { type: "array", items: { type: "string" } },
		proposed_changes: { type: "array", items: { type: "string" } },
	},
	additionalProperties: false,
} as const;

const LANE_OUTPUT_SCHEMA = {
	type: "object",
	required: ["summary", "observations", "changed_files", "plan_impact"],
	properties: {
		summary: { type: "string" },
		observations: { type: "array", items: { type: "string" } },
		changed_files: { type: "array", items: { type: "string" } },
		plan_impact: PLAN_IMPACT_SCHEMA,
	},
	additionalProperties: false,
} as const;

const REVIEW_OUTPUT_SCHEMA = {
	type: "object",
	required: ["verdict", "findings", "residual_risks", "plan_impact"],
	properties: {
		verdict: { type: "string", enum: ["pass", "reject", "escalate"] },
		findings: { type: "array", items: { type: "string" } },
		residual_risks: { type: "array", items: { type: "string" } },
		plan_impact: PLAN_IMPACT_SCHEMA,
	},
	additionalProperties: false,
} as const;

interface ReviewOutput {
	verdict: "pass" | "reject" | "escalate";
	findings: string[];
	residual_risks: string[];
	plan_impact: ZZWPlanImpact;
}

interface LaneOutput {
	summary: string;
	observations: string[];
	changed_files: string[];
	plan_impact: ZZWPlanImpact;
}

export interface ZZWExecutionLaneSummary {
	laneId: string;
	stepId: string;
	executor: ZZWExecutionLane["executor"];
	status: ZZWExecutionLane["status"];
	exitCode?: number;
	output?: string;
	error?: string;
	evidenceIds: string[];
	artifactIds: string[];
	planImpact?: ZZWPlanImpact;
}

export interface ZZWExecutionRunSummary {
	waveId: string;
	status: string;
	lanes: ZZWExecutionLaneSummary[];
	deferred: TaskPreparedExecutionWave["deferred"];
}

interface LaneRunResult {
	laneId: string;
	exitCode?: number;
	output?: string;
	error?: string;
	subagent?: StructuredSubagentResult;
	review?: ReviewOutput;
	planImpact?: ZZWPlanImpact;
}

function digest(value: string): string {
	return Bun.hash(value).toString(16);
}

function workUnitForLane(lane: ZZWExecutionLane, step: TaskPlanStep): ZZWWorkUnitContract | undefined {
	if (!lane.workUnitId) return undefined;
	return step.execution?.workUnits?.find(workUnit => workUnit.id === lane.workUnitId);
}

function laneAssignment(runtime: TaskLifecycleRuntime, lane: ZZWExecutionLane, step: TaskPlanStep): string {
	const workUnit = workUnitForLane(lane, step);
	const wave = runtime.state?.execution.waves.find(candidate => candidate.id === lane.waveId);
	return prompt.render(zzwExecutionLanePrompt, {
		laneId: lane.id,
		stepId: step.id,
		executor: lane.executor,
		workUnitId: workUnit?.id,
		role: lane.role ?? "implementer",
		content: workUnit?.content ?? step.content,
		expectedEffects: workUnit?.expectedEffects ?? step.expectedEffects ?? [],
		allowedTargets: workUnit?.allowedTargets ?? step.allowedTargets ?? [],
		postconditions: workUnit?.postconditions ?? step.postconditions ?? [],
		resourceClaims: workUnit?.resourceClaims ?? lane.resourceClaims,
		validators: workUnit?.validators ?? lane.candidateValidators ?? step.validators ?? [],
		allowedTools: workUnit?.allowedTools ?? step.allowedTools ?? [],
		specVersion: wave?.specVersion ?? runtime.state?.specVersion ?? 0,
		planVersion: wave?.planVersion ?? runtime.state?.planVersion ?? 0,
		stepContractHash: lane.stepContractHash,
		baseWorkspaceHash: lane.baseWorkspaceHash ?? "unavailable",
		assumptionIds: step.assumptionIds ?? [],
		successConditionIds: step.successConditionIds ?? [],
		verificationIds: step.verificationIds ?? [],
		isRepair: lane.role === "repair",
		reviewFindings: lane.reviewFindings ?? [],
	});
}

const PLAN_IMPACT_KINDS = new Set<ZZWPlanImpactKind>([
	"none",
	"implementation-feedback",
	"missing-precondition",
	"execution-failure",
	"contradicted-precondition",
	"contradicted-assumption",
	"unexpected-effect",
	"missing-step",
	"dependency-change",
	"resource-change",
	"validation-change",
	"scope-change",
	"risk-change",
	"contract-decision",
]);

const PLAN_IMPACT_LEVEL_KINDS: Record<ZZWPlanImpact["level"], ReadonlySet<ZZWPlanImpactKind>> = {
	none: new Set(["none"]),
	execution: new Set(["implementation-feedback", "missing-precondition", "execution-failure"]),
	structural: new Set([
		"contradicted-precondition",
		"contradicted-assumption",
		"unexpected-effect",
		"missing-step",
		"dependency-change",
		"resource-change",
		"validation-change",
	]),
	contract: new Set(["scope-change", "risk-change", "contract-decision"]),
};

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? [...value] : undefined;
}

function parsePlanImpact(value: unknown): ZZWPlanImpact | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	const level = candidate.level;
	const kind = candidate.kind;
	if (
		(level !== "none" && level !== "execution" && level !== "structural" && level !== "contract") ||
		typeof kind !== "string" ||
		!PLAN_IMPACT_KINDS.has(kind as ZZWPlanImpactKind) ||
		!PLAN_IMPACT_LEVEL_KINDS[level].has(kind as ZZWPlanImpactKind) ||
		typeof candidate.reason !== "string"
	) {
		return undefined;
	}
	const evidence = stringArray(candidate.evidence);
	const affectedStepIds = stringArray(candidate.affected_step_ids);
	const contradictedAssumptionIds = stringArray(candidate.contradicted_assumption_ids);
	const proposedChanges = stringArray(candidate.proposed_changes);
	if (!evidence || !affectedStepIds || !contradictedAssumptionIds || !proposedChanges) return undefined;
	if (level !== "none" && candidate.reason.trim().length === 0) return undefined;
	return {
		level,
		kind: kind as ZZWPlanImpactKind,
		reason: candidate.reason,
		evidence,
		affectedStepIds,
		contradictedAssumptionIds,
		proposedChanges,
	};
}

function parseLaneOutput(value: unknown): LaneOutput | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	const observations = stringArray(candidate.observations);
	const changedFiles = stringArray(candidate.changed_files);
	const planImpact = parsePlanImpact(candidate.plan_impact);
	if (typeof candidate.summary !== "string" || !observations || !changedFiles || !planImpact) return undefined;
	return { summary: candidate.summary, observations, changed_files: changedFiles, plan_impact: planImpact };
}

function allowedChildTools(lane: ZZWExecutionLane, step: TaskPlanStep): string[] {
	const declared = workUnitForLane(lane, step)?.allowedTools ?? step.allowedTools ?? [];
	if (lane.executor === "subagent-readonly") {
		const selected = declared.filter(tool => READ_ONLY_TOOLS.has(tool));
		return selected.length > 0 ? selected : ["read", "grep", "glob", "lsp"];
	}
	return declared.filter(
		tool => !CONTROLLER_TOOLS.has(tool) && !tool.startsWith("zzw_") && !tool.startsWith("knowledge_"),
	);
}

function normalizeTarget(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function targetAllowed(file: string, allowedTargets: readonly string[]): boolean {
	const normalizedFile = normalizeTarget(file);
	return allowedTargets.some(target => {
		const normalizedTarget = normalizeTarget(target);
		return (
			normalizedTarget === "." ||
			normalizedFile === normalizedTarget ||
			normalizedFile.startsWith(`${normalizedTarget}/`)
		);
	});
}

async function assertPatchScope(
	result: StructuredSubagentResult,
	lane: ZZWExecutionLane,
	step: TaskPlanStep,
): Promise<void> {
	const workUnit = workUnitForLane(lane, step);
	const allowedTargets = workUnit?.allowedTargets ?? step.allowedTargets ?? [];
	if (allowedTargets.length === 0) throw new Error(`step ${step.id} has no allowed integration targets`);
	if ((result.result.nestedPatches?.length ?? 0) > 0) {
		throw new Error("ZZW isolated lanes do not integrate nested repository patches automatically");
	}
	if (!result.result.patchPath) return;
	const patch = await Bun.file(result.result.patchPath).text();
	const claimedTargets = (workUnit?.resourceClaims ?? step.execution?.resourceClaims ?? [])
		.filter(claim => claim.kind === "workspace-path" && (claim.access === "write" || claim.access === "exclusive"))
		.map(claim => claim.key);
	const rejected = patchTouchedFiles(patch).filter(
		file => !targetAllowed(file, allowedTargets) || !targetAllowed(file, claimedTargets),
	);
	if (rejected.length > 0) {
		throw new Error(`isolated lane changed paths outside its Plan scope: ${rejected.join(", ")}`);
	}
}

async function runValidatorLane(
	session: ToolSession,
	runtime: TaskLifecycleRuntime,
	lane: ZZWExecutionLane,
	step: TaskPlanStep,
	settings: ZZWExecutionSettings,
	getIsolationContext: () => Promise<IsolationContext>,
	signal: AbortSignal | undefined,
	initialPatchPath?: string,
): Promise<LaneRunResult> {
	await runtime.markExecutionLaneRunning(lane.id);
	const validator = lane.validators?.[0];
	if (!validator) throw new Error(`validator lane ${lane.id} has no command`);
	try {
		const artifact = await session.allocateOutputArtifact?.("zzw-validator");
		const execute = (cwd: string) =>
			executeBash(validator, {
				cwd,
				timeout: lane.maxRuntimeMs ?? 0,
				signal,
				sessionKey: `zzw:${lane.id}`,
				artifactPath: artifact?.path,
				artifactId: artifact?.id,
			});
		const requiresIsolation =
			initialPatchPath !== undefined ||
			(step.execution?.isolation !== undefined && step.execution.isolation !== "none") ||
			lane.resourceClaims.some(claim => claim.access !== "read");
		const result = requiresIsolation
			? await runInIsolatedWorkspace(
					{
						context: await getIsolationContext(),
						sourceCwd: session.cwd,
						ownerId: `zzw-${lane.id}`,
						isolationMode: settings.isolationMode,
						initialPatchPath,
					},
					execute,
				)
			: await execute(session.cwd);
		const settled = await runtime.settleExecutionLane({
			laneId: lane.id,
			validator,
			exitCode: result.exitCode,
			outputDigest: digest(result.output),
			artifactIds: result.artifactId ? [result.artifactId] : [],
			error: result.exitCode === 0 ? undefined : result.output,
			cancelled: result.cancelled,
			interrupted: signal?.aborted === true,
		});
		return {
			laneId: lane.id,
			exitCode: result.exitCode,
			output: result.output,
			error: settled.error,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await runtime.settleExecutionLane({
			laneId: lane.id,
			validator,
			exitCode: 1,
			outputDigest: digest(message),
			error: message,
			interrupted: signal?.aborted === true,
		});
		return { laneId: lane.id, exitCode: 1, error: message };
	}
}

async function runSubagentLane(
	session: ToolSession,
	runtime: TaskLifecycleRuntime,
	lane: ZZWExecutionLane,
	step: TaskPlanStep,
	settings: ZZWExecutionSettings,
	parentToolCallId: string,
	signal: AbortSignal | undefined,
): Promise<LaneRunResult> {
	await runtime.markExecutionLaneRunning(lane.id);
	const childSettings = await session.settings.cloneForCwd(session.cwd);
	if (lane.executor === "subagent-isolated") {
		childSettings.override("task.isolation.mode", settings.isolationMode);
	}
	const childSession: ToolSession = { ...session, settings: childSettings };
	try {
		const execution = await runStructuredSubagent({
			session: childSession,
			invocationKind: "task",
			assignment: laneAssignment(runtime, lane, step),
			agent: step.execution?.agent,
			model: lane.modelSelector,
			allowModelAuthFallback: false,
			outputSchema: LANE_OUTPUT_SCHEMA,
			schemaMode: "strict",
			identity: { label: `ZZW-${step.id}` },
			parentToolCallId,
			isolation:
				lane.executor === "subagent-isolated" ? { requested: true, merge: "patch", apply: false } : undefined,
			retainArtifacts: settings.preserveFailedLanes || lane.executor === "subagent-isolated",
			enableLsp: true,
			enableIrc: false,
			maxRuntimeMs: lane.maxRuntimeMs ?? step.execution?.maxRuntimeMs,
			allowedTools: allowedChildTools(lane, step),
			signal,
		});
		const laneOutput = parseLaneOutput(execution.result.structuredOutput?.data);
		const schemaError = laneOutput ? undefined : "Work Unit returned an invalid plan-impact result.";
		const output = laneOutput?.summary ?? execution.result.output;
		const settled = await runtime.settleExecutionLane({
			laneId: lane.id,
			exitCode: schemaError ? 1 : execution.result.exitCode,
			outputDigest: digest(`${output}\n${execution.result.stderr}`),
			patchPath: execution.result.patchPath,
			branchName: execution.result.branchName,
			planImpact: laneOutput?.plan_impact,
			error:
				schemaError ||
				execution.result.error ||
				(execution.result.exitCode === 0 ? undefined : execution.result.stderr),
			cancelled: execution.result.aborted,
			interrupted: signal?.aborted === true,
		});
		return {
			laneId: lane.id,
			exitCode: execution.result.exitCode,
			output,
			error: settled.error,
			subagent: execution,
			planImpact: laneOutput?.plan_impact,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await runtime.settleExecutionLane({
			laneId: lane.id,
			exitCode: 1,
			outputDigest: digest(message),
			error: message,
			interrupted: signal?.aborted === true,
		});
		return { laneId: lane.id, exitCode: 1, error: message };
	} finally {
		childSettings.cancelPendingSaves();
	}
}

function parseReviewOutput(value: unknown): ReviewOutput | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<ReviewOutput>;
	if (
		(candidate.verdict !== "pass" && candidate.verdict !== "reject" && candidate.verdict !== "escalate") ||
		!Array.isArray(candidate.findings) ||
		!candidate.findings.every(item => typeof item === "string") ||
		!Array.isArray(candidate.residual_risks) ||
		!candidate.residual_risks.every(item => typeof item === "string") ||
		!parsePlanImpact(candidate.plan_impact)
	) {
		return undefined;
	}
	return {
		verdict: candidate.verdict,
		findings: [...candidate.findings],
		residual_risks: [...candidate.residual_risks],
		plan_impact: parsePlanImpact(candidate.plan_impact) as ZZWPlanImpact,
	};
}

async function runAdversarialReviewLane(
	session: ToolSession,
	runtime: TaskLifecycleRuntime,
	reviewer: ZZWExecutionLane,
	candidate: ZZWExecutionLane,
	step: TaskPlanStep,
	parentToolCallId: string,
	signal: AbortSignal | undefined,
): Promise<LaneRunResult> {
	await runtime.markExecutionLaneRunning(reviewer.id);
	const childSettings = await session.settings.cloneForCwd(session.cwd);
	const childSession: ToolSession = { ...session, settings: childSettings };
	let review: ReviewOutput | undefined;
	let output = "";
	let error: string | undefined;
	try {
		const workUnit = workUnitForLane(candidate, step);
		const wave = runtime.state?.execution.waves.find(item => item.id === candidate.waveId);
		const patch = candidate.patchPath ? await Bun.file(candidate.patchPath).text() : "";
		const execution = await runStructuredSubagent({
			session: childSession,
			invocationKind: "task",
			assignment: prompt.render(zzwAdversarialReviewPrompt, {
				stepId: step.id,
				workUnitId: candidate.workUnitId ?? "단계 전체",
				candidateLaneId: candidate.id,
				content: workUnit?.content ?? step.content,
				expectedEffects: workUnit?.expectedEffects ?? step.expectedEffects ?? [],
				allowedTargets: workUnit?.allowedTargets ?? step.allowedTargets ?? [],
				postconditions: workUnit?.postconditions ?? step.postconditions ?? [],
				resourceClaims: workUnit?.resourceClaims ?? candidate.resourceClaims,
				validators: workUnit?.validators ?? candidate.candidateValidators ?? step.validators ?? [],
				specVersion: wave?.specVersion ?? runtime.state?.specVersion ?? 0,
				planVersion: wave?.planVersion ?? runtime.state?.planVersion ?? 0,
				stepContractHash: candidate.stepContractHash,
				baseWorkspaceHash: candidate.baseWorkspaceHash ?? "unavailable",
				assumptionIds: step.assumptionIds ?? [],
				patch,
			}),
			agent: step.execution?.agent,
			model: reviewer.modelSelector,
			allowModelAuthFallback: false,
			outputSchema: REVIEW_OUTPUT_SCHEMA,
			schemaMode: "strict",
			identity: { label: `ZZW-Review-${candidate.workUnitId ?? step.id}` },
			parentToolCallId,
			retainArtifacts: true,
			enableLsp: true,
			enableIrc: false,
			allowedTools: ["read", "grep", "glob", "lsp"],
			signal,
		});
		output = execution.result.output;
		review = parseReviewOutput(execution.result.structuredOutput?.data);
		if (!review) error = execution.result.error ?? "Adversarial reviewer returned an invalid verdict.";
		await runtime.settleExecutionLane({
			laneId: reviewer.id,
			exitCode: review ? 0 : 1,
			outputDigest: digest(`${output}\n${execution.result.stderr}`),
			error,
			cancelled: execution.result.aborted,
			interrupted: signal?.aborted === true,
		});
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
		await runtime.settleExecutionLane({
			laneId: reviewer.id,
			exitCode: 1,
			outputDigest: digest(error),
			error,
			interrupted: signal?.aborted === true,
		});
	} finally {
		childSettings.cancelPendingSaves();
	}
	const recorded = review ?? {
		verdict: "escalate" as const,
		findings: [error ?? "Adversarial review could not establish a safe verdict."],
		residual_risks: ["The candidate has not passed an independent adversarial review."],
		plan_impact: {
			level: "contract" as const,
			kind: "contract-decision" as const,
			reason: error ?? "독립 리뷰가 안전한 판정을 확정하지 못했습니다.",
			evidence: [],
			affectedStepIds: [candidate.stepId],
			contradictedAssumptionIds: [],
			proposedChanges: [],
		},
	};
	await runtime.recordAdversarialReview({
		reviewerLaneId: reviewer.id,
		verdict: recorded.verdict,
		findings: recorded.findings,
		residualRisks: recorded.residual_risks,
		planImpact: recorded.plan_impact,
	});
	return {
		laneId: reviewer.id,
		exitCode: review ? 0 : 1,
		output,
		error,
		review: recorded,
		planImpact: recorded.plan_impact,
	};
}

async function integrateIsolatedLane(
	session: ToolSession,
	runtime: TaskLifecycleRuntime,
	lane: ZZWExecutionLane,
	result: StructuredSubagentResult,
): Promise<void> {
	const repoRoot = await getRepoRoot(session.cwd);
	const currentLane = runtime.state?.execution.lanes.find(candidate => candidate.id === lane.id);
	if (currentLane?.status !== "awaiting-integration") return;
	const step = runtime.state?.plan.steps.find(candidate => candidate.id === lane.stepId);
	if (!step) return;
	let summary = "";
	try {
		await assertPatchScope(result, currentLane, step);
		await runtime.prepareLaneIntegration(lane.id);
		const outcome = await mergeIsolatedChanges({
			result: result.result,
			repoRoot,
			mergeMode: "patch",
		});
		summary = outcome.summary;
		await runtime.settleLaneIntegration({
			laneId: lane.id,
			succeeded: outcome.changesApplied === true,
			outputDigest: digest(summary),
			error: outcome.changesApplied === false ? summary : undefined,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const hasPreparedIntegration = runtime.operations.some(
			operation =>
				operation.toolName === "zzw-integrate" && operation.laneId === lane.id && operation.status === "running",
		);
		if (!hasPreparedIntegration) await runtime.prepareLaneIntegration(lane.id);
		await runtime.settleLaneIntegration({
			laneId: lane.id,
			succeeded: false,
			outputDigest: digest(message),
			error: message,
		});
	}
}

async function processIsolatedCandidate(
	session: ToolSession,
	runtime: TaskLifecycleRuntime,
	initialLane: ZZWExecutionLane,
	initialResult: StructuredSubagentResult,
	settings: ZZWExecutionSettings,
	parentToolCallId: string,
	getIsolationContext: () => Promise<IsolationContext>,
	integrationCapacity: Semaphore,
	signal: AbortSignal | undefined,
	results: LaneRunResult[],
): Promise<void> {
	let lane = initialLane;
	let subagentResult = initialResult;
	while (true) {
		const current = runtime.state?.execution.lanes.find(candidate => candidate.id === lane.id);
		const step = runtime.state?.plan.steps.find(candidate => candidate.id === lane.stepId);
		if (!current || !step) return;
		if (current.status === "awaiting-review") {
			const reviewer = await runtime.prepareAdversarialReviewLane(current.id);
			const reviewResult = await runAdversarialReviewLane(
				session,
				runtime,
				reviewer,
				current,
				step,
				parentToolCallId,
				signal,
			);
			results.push(reviewResult);
		}
		let afterGate = runtime.state?.execution.lanes.find(candidate => candidate.id === lane.id);
		if (!afterGate) return;
		if (afterGate.status === "awaiting-validation") {
			const validators = await runtime.prepareCandidateValidatorLanes(afterGate.id);
			const validatorRuns = await Promise.all(
				validators.map(validator =>
					runValidatorLane(
						session,
						runtime,
						validator,
						step,
						settings,
						getIsolationContext,
						signal,
						afterGate?.patchPath,
					),
				),
			);
			results.push(...validatorRuns);
			afterGate = await runtime.completeCandidateValidation(afterGate.id);
		}
		if (afterGate.status === "awaiting-integration") {
			await integrationCapacity.acquire(signal);
			try {
				await integrateIsolatedLane(session, runtime, afterGate, subagentResult);
			} finally {
				integrationCapacity.release();
			}
			return;
		}
		if (afterGate.status !== "rejected") return;
		const attemptsRemain = (afterGate.attempt ?? 0) < (afterGate.maxRepairAttempts ?? 0);
		const repairable = afterGate.reviewVerdict === "reject" || afterGate.planImpact?.level === "execution";
		if (!repairable || !attemptsRemain) {
			await runtime.finalizeAdversarialReviewFailure(afterGate.id);
			return;
		}
		lane = await runtime.prepareRepairLane(afterGate.id);
		const repairResult = await runSubagentLane(session, runtime, lane, step, settings, parentToolCallId, signal);
		results.push(repairResult);
		if (!repairResult.subagent) {
			const failed = runtime.state?.execution.lanes.find(candidate => candidate.id === lane.id);
			if (failed?.status === "rejected") await runtime.finalizeAdversarialReviewFailure(failed.id);
			return;
		}
		subagentResult = repairResult.subagent;
	}
}

async function integrateIsolatedLanes(
	session: ToolSession,
	runtime: TaskLifecycleRuntime,
	prepared: TaskPreparedExecutionWave,
	results: LaneRunResult[],
	settings: ZZWExecutionSettings,
	parentToolCallId: string,
	getIsolationContext: () => Promise<IsolationContext>,
	integrationCapacity: Semaphore,
	signal: AbortSignal | undefined,
): Promise<void> {
	for (const lane of prepared.lanes.filter(candidate => candidate.executor === "subagent-isolated")) {
		const result = results.find(candidate => candidate.laneId === lane.id)?.subagent;
		if (!result) continue;
		await processIsolatedCandidate(
			session,
			runtime,
			lane,
			result,
			settings,
			parentToolCallId,
			getIsolationContext,
			integrationCapacity,
			signal,
			results,
		);
	}
}

async function finalizeSuccessfulSteps(runtime: TaskLifecycleRuntime, waveId: string): Promise<void> {
	const state = runtime.state;
	if (!state) return;
	const lanes = state.execution.lanes.filter(lane => lane.waveId === waveId);
	for (const stepId of new Set(lanes.map(lane => lane.stepId))) {
		const step = runtime.state?.plan.steps.find(candidate => candidate.id === stepId);
		const stepLanes =
			runtime.state?.execution.lanes.filter(lane => lane.waveId === waveId && lane.stepId === stepId) ?? [];
		if (!step || stepLanes.length === 0) continue;
		const finalLanes = selectZZWExecutionOutcomeLanes(stepLanes);
		if (finalLanes.length === 0) continue;
		const succeeded = finalLanes.every(lane =>
			lane.executor === "subagent-isolated" ? lane.status === "integrated" : lane.status === "succeeded",
		);
		if (!succeeded) continue;
		const evidenceIds = stepLanes.flatMap(lane => lane.evidenceIds);
		if (step.kind === "validation") await runtime.submitVerification({ stepId, evidenceIds });
		else {
			await runtime.reportStepResult({
				stepId,
				status: "completed",
				evidenceIds,
				unexpectedEffects: [],
				classification: "matched",
			});
		}
	}
}

export async function runPreparedExecutionWave(
	session: ToolSession,
	runtime: TaskLifecycleRuntime,
	prepared: TaskPreparedExecutionWave,
	settings: ZZWExecutionSettings,
	parentToolCallId: string,
	signal?: AbortSignal,
): Promise<ZZWExecutionRunSummary> {
	const state = runtime.state;
	if (!state) throw new Error("활성 ZZWorkflow가 없습니다.");
	const steps = new Map(state.plan.steps.map(step => [step.id, step]));
	const serialExecution = settings.mode === "serial";
	const concurrency = serialExecution ? 1 : settings.validationConcurrency + settings.subagentConcurrency;
	const resourceLock = new ZZWResourceClaimLock();
	const validatorCapacity = new Semaphore(serialExecution ? 1 : settings.validationConcurrency);
	const subagentCapacity = new Semaphore(serialExecution ? 1 : settings.subagentConcurrency);
	const integrationCapacity = new Semaphore(1);
	const waveAbort = new AbortController();
	const waveSignal = signal ? AbortSignal.any([signal, waveAbort.signal]) : waveAbort.signal;
	let isolationContext: Promise<IsolationContext> | undefined;
	const getIsolationContext = () => (isolationContext ??= prepareIsolationContext(session.cwd));
	const results: LaneRunResult[] = [];
	const deferred = [...prepared.deferred];
	let batch = prepared;
	while (batch.lanes.length > 0) {
		const laneAbortControllers = new Map(batch.lanes.map(lane => [lane.id, new AbortController()]));
		const abortFailureDomain = (failedLane: ZZWExecutionLane, step: TaskPlanStep, result: LaneRunResult): void => {
			if (result.exitCode === 0 && !result.error) return;
			const domain = effectiveStepExecution(step).failureDomain;
			const reason = new Error(`Lane ${failedLane.id} failed in ${domain} failure domain`);
			if (domain === "wave") {
				waveAbort.abort(reason);
				return;
			}
			if (domain !== "shared-resource") return;
			for (const candidate of batch.lanes) {
				if (candidate.id === failedLane.id) continue;
				const sharesResource = failedLane.resourceClaims.some(left =>
					candidate.resourceClaims.some(right => resourceKeysOverlap(left, right)),
				);
				if (sharesResource) laneAbortControllers.get(candidate.id)?.abort(reason);
			}
		};
		const { results: settledResults } = await mapWithConcurrencyLimitAllSettled(
			batch.lanes,
			concurrency,
			lane => {
				const laneAbort = laneAbortControllers.get(lane.id);
				const laneSignal = laneAbort ? AbortSignal.any([waveSignal, laneAbort.signal]) : waveSignal;
				const capacity = lane.executor === "validator" ? validatorCapacity : subagentCapacity;
				return (async () => {
					await capacity.acquire(laneSignal);
					try {
						return await resourceLock.run(lane.id, lane.resourceClaims, async () => {
							if (laneSignal.aborted) throw laneSignal.reason;
							const step = steps.get(lane.stepId);
							if (!step) throw new Error(`unknown Plan step: ${lane.stepId}`);
							let result: LaneRunResult | undefined;
							if (lane.executor === "validator") {
								result = await runValidatorLane(
									session,
									runtime,
									lane,
									step,
									settings,
									getIsolationContext,
									laneSignal,
								);
							}
							if (lane.executor === "subagent-readonly" || lane.executor === "subagent-isolated") {
								result = await runSubagentLane(
									session,
									runtime,
									lane,
									step,
									settings,
									parentToolCallId,
									laneSignal,
								);
							}
							if (!result) throw new Error(`primary lane ${lane.id} must be executed by the main agent`);
							abortFailureDomain(lane, step, result);
							return result;
						});
					} finally {
						capacity.release();
					}
				})();
			},
			waveSignal,
		);
		for (const [index, settled] of settledResults.entries()) {
			if (settled?.status === "fulfilled") results.push(settled.value);
			else if (settled?.status === "rejected") {
				const lane = batch.lanes[index];
				const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
				results.push({ laneId: lane.id, exitCode: 1, error: message });
			}
		}
		for (const lane of batch.lanes) {
			const current = runtime.state?.execution.lanes.find(candidate => candidate.id === lane.id);
			if (
				current?.status !== "prepared" &&
				current?.status !== "running" &&
				current?.status !== "cancel-requested"
			) {
				continue;
			}
			if (current.status === "prepared") await runtime.markExecutionLaneRunning(lane.id);
			await runtime.settleExecutionLane({
				laneId: lane.id,
				validator: lane.validators?.[0],
				outputDigest: digest("Execution Wave ended before Lane settlement"),
				error: "Execution Wave ended before Lane settlement",
				cancelled: waveSignal.aborted,
				interrupted: true,
			});
			results.push({ laneId: lane.id, error: "Execution Wave ended before Lane settlement" });
		}
		if (waveSignal.aborted) break;
		await integrateIsolatedLanes(
			session,
			runtime,
			batch,
			results,
			settings,
			parentToolCallId,
			getIsolationContext,
			integrationCapacity,
			waveSignal,
		);
		await finalizeSuccessfulSteps(runtime, prepared.wave.id);
		const snapshotBarrier = batch.lanes.some(
			lane =>
				lane.executor === "subagent-isolated" &&
				runtime.state?.execution.lanes.find(candidate => candidate.id === lane.id)?.status === "integrated",
		);
		if (!settings.rollingEpoch || snapshotBarrier || runtime.state?.execution.activeWaveId !== prepared.wave.id)
			break;
		const admitted = await runtime.admitExecutionWave(prepared.wave.id, {
			mode: settings.mode,
			validationConcurrency: settings.validationConcurrency,
			subagentConcurrency: settings.subagentConcurrency,
			rollingEpoch: settings.rollingEpoch,
			workUnitsEnabled: settings.workUnits.enabled,
			workUnitModel: settings.workUnits.model,
			adversarialReviewEnabled: settings.adversarialReview.enabled,
			adversarialReviewerModel: settings.adversarialReview.model,
			maxRepairAttempts: settings.adversarialReview.maxRepairAttempts,
		});
		deferred.push(...admitted.deferred);
		if (admitted.lanes.length === 0) break;
		for (const lane of admitted.lanes) {
			const step = runtime.state?.plan.steps.find(candidate => candidate.id === lane.stepId);
			if (step) steps.set(step.id, step);
		}
		batch = admitted;
	}
	if (waveSignal.aborted) {
		for (const lane of runtime.state?.execution.lanes.filter(item => item.waveId === prepared.wave.id) ?? []) {
			if (lane.status === "awaiting-integration") {
				await runtime.cancelLaneBeforeIntegration(lane.id, "Execution Wave cancelled before integration");
			}
		}
	}
	const activeWave = runtime.state?.execution.waves.find(wave => wave.id === prepared.wave.id);
	if (activeWave?.admissionOpen === true) await runtime.closeExecutionWaveAdmission(prepared.wave.id);
	await finalizeSuccessfulSteps(runtime, prepared.wave.id);
	const current = runtime.state;
	const lanes =
		current?.execution.lanes
			.filter(lane => lane.waveId === prepared.wave.id)
			.map(lane => {
				const result = results.find(candidate => candidate.laneId === lane.id);
				return {
					laneId: lane.id,
					stepId: lane.stepId,
					executor: lane.executor,
					status: lane.status,
					exitCode: result?.exitCode,
					output: result?.output,
					error: lane.error ?? result?.error,
					evidenceIds: [...lane.evidenceIds],
					artifactIds: [...lane.artifactIds],
					planImpact: lane.planImpact,
				};
			}) ?? [];
	return {
		waveId: prepared.wave.id,
		status: current?.execution.waves.find(wave => wave.id === prepared.wave.id)?.status ?? "unknown",
		lanes,
		deferred,
	};
}
