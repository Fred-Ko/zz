import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import {
	summarizeTaskLifecycle,
	type TaskObservation,
	type TaskPlan,
	type TaskPlanPatch,
	type TaskPlanStepProposal,
	TaskPlanValidationError,
} from "../goals/task-lifecycle";
import getStateDescription from "../prompts/tools/workflow-get-state.md" with { type: "text" };
import patchPlanDescription from "../prompts/tools/workflow-patch-plan.md" with { type: "text" };
import proposePlanDescription from "../prompts/tools/workflow-propose-plan.md" with { type: "text" };
import reportObservationDescription from "../prompts/tools/workflow-report-observation.md" with { type: "text" };
import reportStepResultDescription from "../prompts/tools/workflow-report-step-result.md" with { type: "text" };
import submitVerificationDescription from "../prompts/tools/workflow-submit-verification.md" with { type: "text" };
import { loadZZWorkflowConfig } from "../workflow/config";
import type { ToolSession } from ".";
import { previewLine, TRUNCATE_LENGTHS } from "./render-utils";

const stepKind = type("'work' | 'validation' | 'acceptance' | 'milestone'");
const rerunPolicy = type("'safe' | 'guarded' | 'never'");
const riskClass = type("'low' | 'medium' | 'high'");
const resourceKind = type(
	"'workspace-path' | 'git-metadata' | 'lockfile' | 'cache' | 'port' | 'service' | 'database' | 'external-api' | 'cpu' | 'memory'",
);
const resourceClaimSchema = type({
	"+": "reject",
	kind: resourceKind,
	key: "string",
	access: type("'read' | 'write' | 'exclusive'"),
});
const capabilityClass = type("'mechanical' | 'local-reasoning' | 'system-reasoning'");
const delegationAssessmentSchema = type({
	"+": "reject",
	decision: type("'retain-primary' | 'delegate-readonly' | 'delegate-isolated'"),
	reason_code: type(
		"'cross-cutting-reasoning' | 'shared-write-surface' | 'unbounded-scope' | 'exclusive-resource' | 'high-risk-side-effect' | 'atomic-sequence' | 'bounded-readonly' | 'bounded-isolated-write'",
	),
	rationale: "string",
});
const workUnitSchema = type({
	"+": "reject",
	id: "string",
	content: "string",
	expected_effects: "string[]",
	allowed_tools: "string[]",
	allowed_targets: "string[]",
	postconditions: "string[]",
	resource_claims: resourceClaimSchema.array(),
	validators: "string[]",
	capability: capabilityClass,
	"max_runtime_ms?": "number",
});
const executionContractSchema = type({
	"+": "reject",
	executor: type("'primary' | 'validator' | 'subagent-readonly' | 'subagent-isolated'"),
	"delegation_assessment?": delegationAssessmentSchema,
	resource_claims: resourceClaimSchema.array(),
	isolation: type("'none' | 'snapshot' | 'required'"),
	integration: type("'none' | 'patch'"),
	failure_domain: type("'step' | 'wave' | 'shared-resource'"),
	"max_runtime_ms?": "number",
	"agent?": "string",
	"capability?": capabilityClass,
	"work_units?": workUnitSchema.array(),
});

const planStepSchema = type({
	"+": "reject",
	id: "string",
	phase: "string",
	content: "string",
	kind: stepKind,
	depends_on: "string[]",
	expected_effects: "string[]",
	allowed_tools: "string[]",
	allowed_targets: "string[]",
	postconditions: "string[]",
	success_condition_ids: "string[]",
	verification_ids: "string[]",
	validators: "string[]",
	rerun_policy: rerunPolicy,
	risk_class: riskClass,
	"parent_step_id?": "string",
	"supersedes?": "string[]",
	"assumption_ids?": "string[]",
	"consumes_artifacts?": "string[]",
	"produces_artifacts?": "string[]",
	"execution?": executionContractSchema,
});

const planStepPatchSchema = type({
	"+": "reject",
	id: "string",
	"phase?": "string",
	"content?": "string",
	"kind?": stepKind,
	"depends_on?": "string[]",
	"expected_effects?": "string[]",
	"allowed_tools?": "string[]",
	"allowed_targets?": "string[]",
	"postconditions?": "string[]",
	"success_condition_ids?": "string[]",
	"verification_ids?": "string[]",
	"validators?": "string[]",
	"rerun_policy?": rerunPolicy,
	"risk_class?": riskClass,
	"parent_step_id?": "string",
	"supersedes?": "string[]",
	"assumption_ids?": "string[]",
	"consumes_artifacts?": "string[]",
	"produces_artifacts?": "string[]",
	"execution?": executionContractSchema,
});

function requireRuntime(session: ToolSession) {
	const runtime = session.getTaskLifecycleRuntime?.();
	if (!runtime?.state)
		throw new Error("활성 ZZWorkflow가 없습니다. 먼저 /zzw-goal 또는 /zzw-guided-goal을 실행하세요.");
	return runtime;
}

function planApprovalResultText(plan: TaskPlan, heading: string): string {
	const steps = plan.steps.map(
		(step, index) =>
			`${index + 1}. [${previewLine(step.id, TRUNCATE_LENGTHS.TITLE)}] ${previewLine(step.content, TRUNCATE_LENGTHS.LONG)}`,
	);
	return [heading, "", ...steps, "", "승인 후 실행:", "/zzw approve-plan"].join("\n");
}

function stepProposal(step: typeof planStepSchema.infer): TaskPlanStepProposal {
	return {
		id: step.id,
		phase: step.phase,
		content: step.content,
		kind: step.kind,
		dependsOn: [...step.depends_on],
		expectedEffects: [...step.expected_effects],
		allowedTools: [...step.allowed_tools],
		allowedTargets: [...step.allowed_targets],
		postconditions: [...step.postconditions],
		successConditionIds: [...step.success_condition_ids],
		verificationIds: [...step.verification_ids],
		validators: [...step.validators],
		rerunPolicy: step.rerun_policy,
		riskClass: step.risk_class,
		parentStepId: step.parent_step_id,
		supersedes: [...(step.supersedes ?? [])],
		assumptionIds: [...(step.assumption_ids ?? [])],
		consumesArtifacts: [...(step.consumes_artifacts ?? [])],
		producesArtifacts: [...(step.produces_artifacts ?? [])],
		execution: step.execution
			? {
					executor: step.execution.executor,
					delegationAssessment: step.execution.delegation_assessment
						? {
								decision: step.execution.delegation_assessment.decision,
								reasonCode: step.execution.delegation_assessment.reason_code,
								rationale: step.execution.delegation_assessment.rationale,
							}
						: undefined,
					resourceClaims: step.execution.resource_claims.map(claim => ({ ...claim })),
					isolation: step.execution.isolation,
					integration: step.execution.integration,
					failureDomain: step.execution.failure_domain,
					maxRuntimeMs: step.execution.max_runtime_ms,
					agent: step.execution.agent,
					capability: step.execution.capability,
					workUnits: step.execution.work_units?.map(workUnit => ({
						id: workUnit.id,
						content: workUnit.content,
						expectedEffects: [...workUnit.expected_effects],
						allowedTools: [...workUnit.allowed_tools],
						allowedTargets: [...workUnit.allowed_targets],
						postconditions: [...workUnit.postconditions],
						resourceClaims: workUnit.resource_claims.map(claim => ({ ...claim })),
						validators: [...workUnit.validators],
						capability: workUnit.capability,
						maxRuntimeMs: workUnit.max_runtime_ms,
					})),
				}
			: undefined,
	};
}

function stepPatch(step: typeof planStepPatchSchema.infer): TaskPlanPatch["updateSteps"][number] {
	const patch: TaskPlanPatch["updateSteps"][number] = { id: step.id };
	if (step.phase !== undefined) patch.phase = step.phase;
	if (step.content !== undefined) patch.content = step.content;
	if (step.kind !== undefined) patch.kind = step.kind;
	if (step.depends_on !== undefined) patch.dependsOn = [...step.depends_on];
	if (step.expected_effects !== undefined) patch.expectedEffects = [...step.expected_effects];
	if (step.allowed_tools !== undefined) patch.allowedTools = [...step.allowed_tools];
	if (step.allowed_targets !== undefined) patch.allowedTargets = [...step.allowed_targets];
	if (step.postconditions !== undefined) patch.postconditions = [...step.postconditions];
	if (step.success_condition_ids !== undefined) patch.successConditionIds = [...step.success_condition_ids];
	if (step.verification_ids !== undefined) patch.verificationIds = [...step.verification_ids];
	if (step.validators !== undefined) patch.validators = [...step.validators];
	if (step.rerun_policy !== undefined) patch.rerunPolicy = step.rerun_policy;
	if (step.risk_class !== undefined) patch.riskClass = step.risk_class;
	if (step.parent_step_id !== undefined) patch.parentStepId = step.parent_step_id;
	if (step.supersedes !== undefined) patch.supersedes = [...step.supersedes];
	if (step.assumption_ids !== undefined) patch.assumptionIds = [...step.assumption_ids];
	if (step.consumes_artifacts !== undefined) patch.consumesArtifacts = [...step.consumes_artifacts];
	if (step.produces_artifacts !== undefined) patch.producesArtifacts = [...step.produces_artifacts];
	if (step.execution !== undefined) {
		patch.execution = {
			executor: step.execution.executor,
			delegationAssessment: step.execution.delegation_assessment
				? {
						decision: step.execution.delegation_assessment.decision,
						reasonCode: step.execution.delegation_assessment.reason_code,
						rationale: step.execution.delegation_assessment.rationale,
					}
				: undefined,
			resourceClaims: step.execution.resource_claims.map(claim => ({ ...claim })),
			isolation: step.execution.isolation,
			integration: step.execution.integration,
			failureDomain: step.execution.failure_domain,
			maxRuntimeMs: step.execution.max_runtime_ms,
			agent: step.execution.agent,
			capability: step.execution.capability,
			workUnits: step.execution.work_units?.map(workUnit => ({
				id: workUnit.id,
				content: workUnit.content,
				expectedEffects: [...workUnit.expected_effects],
				allowedTools: [...workUnit.allowed_tools],
				allowedTargets: [...workUnit.allowed_targets],
				postconditions: [...workUnit.postconditions],
				resourceClaims: workUnit.resource_claims.map(claim => ({ ...claim })),
				validators: [...workUnit.validators],
				capability: workUnit.capability,
				maxRuntimeMs: workUnit.max_runtime_ms,
			})),
		};
	}
	return patch;
}

function planValidationResult(error: TaskPlanValidationError): AgentToolResult {
	const details = error.toDetails();
	return {
		content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
		details,
		isError: true,
	};
}

const getStateSchema = type({
	"+": "reject",
	detail: type("'summary' | 'spec' | 'plan' | 'evidence' | 'operations' | 'full'"),
});

export class ZZWorkflowGetStateTool implements AgentTool<typeof getStateSchema> {
	readonly name = "zzw_get_state";
	readonly approval = "read" as const;
	readonly label = "ZZWorkflow State";
	readonly summary = "권위 있는 ZZWorkflow 상태 조회";
	readonly description = getStateDescription;
	readonly parameters = getStateSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: typeof getStateSchema.infer): Promise<AgentToolResult> {
		const runtime = requireRuntime(this.session);
		const state = runtime.state;
		if (!state) throw new Error("활성 ZZWorkflow가 없습니다.");
		const executionPolicy = loadZZWorkflowConfig(this.session.settings).execution;
		const summary = summarizeTaskLifecycle(state, executionPolicy.mode, executionPolicy.workUnits.enabled);
		const statePayload =
			params.detail === "summary"
				? {
						...summary,
						taskId: state.taskId,
						phase: state.phase,
						specVersion: state.specVersion,
						planVersion: state.planVersion,
						planApproval: state.plan.approval ?? "draft",
						activeStep: summary?.activePlanStepId,
						reconciliation: state.reconciliation,
						latestPlanChange: state.plan.changes?.at(-1),
						readiness: state.readiness,
						pendingOperationIds: state.pendingOperationIds,
					}
				: params.detail === "spec"
					? state.specification
					: params.detail === "plan"
						? state.plan
						: params.detail === "evidence"
							? { evidence: state.evidence, observations: state.observations ?? [] }
							: params.detail === "operations"
								? runtime.operations
								: state;
		const payload = { ...statePayload, executionPolicy };
		return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
	}
}

const proposePlanSchema = type({
	"+": "reject",
	based_on_spec_version: "number",
	steps: planStepSchema.array().atLeastLength(1),
});

export class ZZWorkflowProposePlanTool implements AgentTool<typeof proposePlanSchema> {
	readonly name = "zzw_propose_plan";
	readonly approval = "read" as const;
	readonly concurrency = "exclusive" as const;
	readonly label = "ZZWorkflow Plan Proposal";
	readonly summary = "승인 대기 Plan DAG 제안";
	readonly description = proposePlanDescription;
	readonly parameters = proposePlanSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: typeof proposePlanSchema.infer): Promise<AgentToolResult> {
		try {
			const plan = await requireRuntime(this.session).proposePlan({
				basedOnSpecVersion: params.based_on_spec_version,
				steps: params.steps.map(stepProposal),
			});
			return {
				content: [
					{
						type: "text",
						text: planApprovalResultText(plan, `Plan DAG v${plan.version} 제안 완료 · 사용자 승인 대기`),
					},
				],
				details: plan,
			};
		} catch (error) {
			if (error instanceof TaskPlanValidationError) return planValidationResult(error);
			throw error;
		}
	}
}

const patchPlanSchema = type({
	"+": "reject",
	based_on_plan_version: "number",
	add_steps: planStepSchema.array(),
	update_steps: planStepPatchSchema.array(),
	remove_step_ids: "string[]",
	preserve_step_ids: "string[]",
	contradicted_assumptions: "string[]",
	failed_step_ids: "string[]",
	"observation_ids?": "string[]",
	"evidence_ids?": "string[]",
	"change_kind?": type("'patch' | 'expansion' | 'repair'"),
	rationale: "string",
});

export class ZZWorkflowPatchPlanTool implements AgentTool<typeof patchPlanSchema> {
	readonly name = "zzw_patch_plan";
	readonly approval = "read" as const;
	readonly concurrency = "exclusive" as const;
	readonly label = "ZZWorkflow Plan Patch";
	readonly summary = "실패 원인에 대한 최소 Plan DAG 패치";
	readonly description = patchPlanDescription;
	readonly parameters = patchPlanSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: typeof patchPlanSchema.infer): Promise<AgentToolResult> {
		const patch: TaskPlanPatch = {
			basedOnPlanVersion: params.based_on_plan_version,
			addSteps: params.add_steps.map(stepProposal),
			updateSteps: params.update_steps.map(stepPatch),
			removeStepIds: [...params.remove_step_ids],
			preserveStepIds: [...params.preserve_step_ids],
			contradictedAssumptions: [...params.contradicted_assumptions],
			failedStepIds: [...params.failed_step_ids],
			observationIds: [...(params.observation_ids ?? [])],
			evidenceIds: [...(params.evidence_ids ?? [])],
			changeKind: params.change_kind,
			rationale: params.rationale,
		};
		try {
			const plan = await requireRuntime(this.session).patchPlan(patch);
			const approvalRequired = plan.approval !== "approved";
			return {
				content: [
					{
						type: "text",
						text: approvalRequired
							? planApprovalResultText(
									plan,
									`Plan DAG v${plan.version} 중요 변경 제안 완료 · 사용자 재승인 대기`,
								)
							: `Plan DAG v${plan.version}에 구조적 변경을 적용했습니다. 기존 승인이 유지되어 실행을 계속할 수 있습니다.`,
					},
				],
				details: plan,
			};
		} catch (error) {
			if (error instanceof TaskPlanValidationError) return planValidationResult(error);
			throw error;
		}
	}
}

const observationSchema = type({
	"+": "reject",
	kind: type("'fact' | 'hypothesis' | 'contradiction' | 'risk' | 'workspace-change'"),
	statement: "string",
	evidence_ids: "string[]",
	confidence: "number",
	affects: type({
		type: type("'spec' | 'assumption' | 'step' | 'artifact' | 'verification'"),
		id: "string",
	}).array(),
});

export class ZZWorkflowReportObservationTool implements AgentTool<typeof observationSchema> {
	readonly name = "zzw_report_observation";
	readonly approval = "read" as const;
	readonly label = "ZZWorkflow Observation";
	readonly summary = "증거에 연결된 관찰과 가설 보고";
	readonly description = reportObservationDescription;
	readonly parameters = observationSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: typeof observationSchema.infer): Promise<AgentToolResult> {
		if (params.confidence < 0 || params.confidence > 1) throw new Error("confidence는 0과 1 사이여야 합니다.");
		const input: Omit<TaskObservation, "id" | "createdAt"> = {
			kind: params.kind,
			statement: params.statement,
			evidenceIds: [...params.evidence_ids],
			confidence: params.confidence,
			affects: params.affects.map(affected => ({ ...affected })),
		};
		const observation = await requireRuntime(this.session).reportObservation(input);
		return { content: [{ type: "text", text: `관찰 ${observation.id}을 기록했습니다.` }], details: observation };
	}
}

const stepResultSchema = type({
	"+": "reject",
	step_id: "string",
	status: type("'completed' | 'failed' | 'partial' | 'progress' | 'blocked'"),
	evidence_ids: "string[]",
	unexpected_effects: "string[]",
	"classification?": type(
		"'matched' | 'implementation-feedback' | 'missing-precondition' | 'execution-failure' | 'contradicted-precondition' | 'contradicted-assumption' | 'unexpected-effect' | 'verification-failure' | 'environment-changed'",
	),
	"observed_effects?": "string[]",
	"contradicted_assumption_ids?": "string[]",
	"changed_condition?": "string",
});

export class ZZWorkflowReportStepResultTool implements AgentTool<typeof stepResultSchema> {
	readonly name = "zzw_report_step_result";
	readonly approval = "read" as const;
	readonly label = "ZZWorkflow Step Result";
	readonly summary = "Plan 단계의 실제 결과 보고";
	readonly description = reportStepResultDescription;
	readonly parameters = stepResultSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: typeof stepResultSchema.infer): Promise<AgentToolResult> {
		const runtime = requireRuntime(this.session);
		const classification =
			params.classification ??
			(params.status === "completed" || params.status === "progress" || params.status === "partial"
				? "matched"
				: params.unexpected_effects.length > 0
					? "unexpected-effect"
					: "execution-failure");
		const step = await runtime.reportStepResult({
			stepId: params.step_id,
			status: params.status,
			evidenceIds: [...params.evidence_ids],
			unexpectedEffects: [...params.unexpected_effects],
			classification,
			observedEffects: [...(params.observed_effects ?? [])],
			contradictedAssumptionIds: [...(params.contradicted_assumption_ids ?? [])],
			changedCondition: params.changed_condition,
		});
		const planPatchRequired = runtime.state?.stalePlan === true || runtime.state?.plan.status === "stale";
		const routineContinuation =
			!planPatchRequired &&
			(classification === "implementation-feedback" || classification === "missing-precondition");
		const reconciliationAction = runtime.state?.reconciliation?.requiredAction;
		const requiredAction = routineContinuation
			? classification === "missing-precondition"
				? "satisfy-approved-precondition-and-retry"
				: "correct-within-active-step-and-retry"
			: planPatchRequired
				? "patch-plan"
				: reconciliationAction
					? reconciliationAction
					: step.status === "completed"
						? "continue-next-step"
						: "continue-active-step";
		const message =
			reconciliationAction === "satisfy-approved-precondition"
				? `단계 ${step.id}: ${step.status}. Plan patch와 재승인은 필요하지 않습니다. 현재 단계의 승인된 tool/target 범위에서 실행 전제를 준비하고, 성공 evidence로 progress를 보고한 뒤 validator를 재시도하세요.`
				: routineContinuation
					? `단계 ${step.id}: ${step.status}. Plan patch와 재승인은 필요하지 않습니다. 같은 단계에서 원인을 처리한 뒤 재시도하세요.`
					: reconciliationAction === "retry-with-changed-condition"
						? `단계 ${step.id}: ${step.status}. 아직 Plan patch 대상이 아닙니다. 실행 조건을 실제로 바꾸거나 결과를 더 정확히 분류하세요.`
						: `단계 ${step.id}: ${step.status}`;
		return {
			content: [{ type: "text", text: message }],
			details: {
				step,
				classification,
				planPatchRequired,
				approvalRequired: runtime.state?.plan.approval !== "approved",
				requiredAction,
			},
		};
	}
}

const verificationSchema = type({
	"+": "reject",
	step_id: "string",
	evidence_ids: "string[]",
});

export class ZZWorkflowSubmitVerificationTool implements AgentTool<typeof verificationSchema> {
	readonly name = "zzw_submit_verification";
	readonly approval = "read" as const;
	readonly label = "ZZWorkflow Verification";
	readonly summary = "최신 trusted validator 증거 제출";
	readonly description = submitVerificationDescription;
	readonly parameters = verificationSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: typeof verificationSchema.infer): Promise<AgentToolResult> {
		const step = await requireRuntime(this.session).submitVerification({
			stepId: params.step_id,
			evidenceIds: [...params.evidence_ids],
		});
		return { content: [{ type: "text", text: `검증 단계 ${step.id}의 최신 증거를 승인했습니다.` }], details: step };
	}
}
