import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import { filterAvailableModelsByEnabledPatterns } from "../config/model-resolver";
import executeWaveDescription from "../prompts/tools/workflow-execute-wave.md" with { type: "text" };
import { loadZZWorkflowConfig } from "../workflow/config";
import {
	effectiveStepExecution,
	resolveZZWorkflowExecutionModels,
	runPreparedExecutionWave,
	toZZWSelectableModel,
} from "../workflow/execution";
import type { ZZWExecutionSettings } from "../workflow/execution/types";
import type { ToolSession } from ".";
import { previewLine, TRUNCATE_LENGTHS } from "./render-utils";

const executeWaveSchema = type({
	"+": "reject",
	"step_ids?": "string[]",
});

function requireRuntime(session: ToolSession) {
	const runtime = session.getTaskLifecycleRuntime?.();
	if (!runtime?.state) {
		throw new Error("활성 ZZWorkflow가 없습니다. 먼저 /zzw-goal 또는 /zzw-guided-goal을 실행하세요.");
	}
	return runtime;
}

export class ZZWorkflowExecuteWaveTool implements AgentTool<typeof executeWaveSchema> {
	readonly name = "zzw_execute_wave";
	readonly approval = "exec" as const;
	readonly label = "ZZWorkflow Execution Wave";
	readonly summary = "ready 검증·격리 Lane을 안전하게 병렬 실행";
	readonly description = executeWaveDescription;
	readonly parameters = executeWaveSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(
		toolCallId: string,
		params: typeof executeWaveSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const runtime = requireRuntime(this.session);
		const state = runtime.state;
		if (!state) throw new Error("활성 ZZWorkflow가 없습니다.");
		const config = loadZZWorkflowConfig(this.session.settings).execution;
		const requested = params.step_ids ? new Set(params.step_ids) : undefined;
		const ready = new Set(runtime.readyStepIds);
		const readySteps = state.plan.steps.filter(step => ready.has(step.id));
		const readyPrimary = state.plan.steps.filter(
			step =>
				(step.status === "in_progress" || ready.has(step.id)) &&
				effectiveStepExecution(step).executor === "primary",
		);
		if (readyPrimary.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Primary workspace 단계가 먼저 실행되어야 합니다: ${readyPrimary.map(step => step.id).join(", ")}`,
					},
				],
				details: {
					accepted: false,
					code: "PRIMARY_STEP_READY",
					executionMode: config.mode,
					readyStepIds: [...ready],
				},
			};
		}
		const executableSteps = readySteps
			.filter(step => ready.has(step.id) && (!requested || requested.has(step.id)))
			.filter(step => effectiveStepExecution(step).executor !== "primary")
			.filter(step => config.mode !== "validation" || effectiveStepExecution(step).executor === "validator");
		const hasIsolatedWrite = executableSteps.some(
			step => effectiveStepExecution(step).executor === "subagent-isolated",
		);
		const executableStepIds = executableSteps
			.filter(step => !hasIsolatedWrite || effectiveStepExecution(step).executor !== "validator")
			.map(step => step.id);
		if (requested) {
			const primary = state.plan.steps.filter(
				step => requested.has(step.id) && effectiveStepExecution(step).executor === "primary",
			);
			if (primary.length > 0) {
				throw new Error(
					`primary 단계는 메인 에이전트가 직접 실행해야 합니다: ${primary.map(step => step.id).join(", ")}`,
				);
			}
		}
		if (executableStepIds.length === 0) {
			return {
				content: [
					{
						type: "text",
						text:
							config.mode === "validation"
								? "현재 validation 모드에서 자동 실행 가능한 validator Lane이 없습니다. subagent 단계는 safe-parallel 설정이 필요하고 primary 단계는 메인 에이전트가 직접 수행합니다."
								: "현재 자동 실행 가능한 ZZW Lane이 없습니다. ready primary 단계를 직접 수행하세요.",
					},
				],
				details: {
					accepted: false,
					code: "NO_AUTOMATED_READY_STEP",
					executionMode: config.mode,
					readyStepIds: [...ready],
				},
			};
		}
		let executionSettings: ZZWExecutionSettings = {
			mode: config.mode,
			validationConcurrency: config.validationConcurrency,
			subagentConcurrency: config.subagentConcurrency,
			isolationMode: config.isolationMode,
			preserveFailedLanes: config.preserveFailedLanes,
			rollingEpoch: config.rollingEpoch,
			workUnits: { ...config.workUnits },
			adversarialReview: { ...config.adversarialReview },
		};
		const hasSubagentLane = executableSteps.some(step =>
			effectiveStepExecution(step).executor.startsWith("subagent-"),
		);
		if (hasSubagentLane) {
			const modelRegistry = this.session.modelRegistry;
			if (!modelRegistry) {
				throw new Error("ZZWorkflow subagent 모델을 검증할 model registry가 없습니다");
			}
			const availableModels = filterAvailableModelsByEnabledPatterns(
				modelRegistry.getAvailable(),
				this.session.settings.get("enabledModels"),
				this.session.settings,
			);
			const selectableModels = availableModels.map(toZZWSelectableModel);
			const activeModel = this.session.getActiveModel?.();
			const activeSelectableModel = activeModel
				? selectableModels.find(model => model.provider === activeModel.provider && model.id === activeModel.id)
				: undefined;
			try {
				const reviewRequired =
					config.adversarialReview.enabled &&
					executableSteps.some(step => effectiveStepExecution(step).executor === "subagent-isolated");
				const resolved = resolveZZWorkflowExecutionModels({
					availableModels: selectableModels,
					activeModel: activeSelectableModel,
					workUnitModel: config.workUnits.model,
					adversarialReviewerModel: reviewRequired ? config.adversarialReview.model : "*",
				});
				executionSettings = {
					...executionSettings,
					workUnits: {
						...executionSettings.workUnits,
						model: resolved.workUnitModel,
					},
					adversarialReview: {
						...executionSettings.adversarialReview,
						model: resolved.adversarialReviewerModel,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `${message}. /settings의 Tasks → ZZWorkflow 실행에서 모델을 다시 선택하세요.`,
						},
					],
					details: {
						accepted: false,
						code: "ZZW_MODEL_UNAVAILABLE",
						availableModelSelectors: selectableModels.map(model => `${model.provider}/${model.id}`),
					},
				};
			}
		}
		const prepared = await runtime.prepareExecutionWave({
			stepIds: executableStepIds,
			mode: config.mode,
			validationConcurrency: config.validationConcurrency,
			subagentConcurrency: config.subagentConcurrency,
			rollingEpoch: config.rollingEpoch,
			workUnitsEnabled: executionSettings.workUnits.enabled,
			workUnitModel: executionSettings.workUnits.model,
			adversarialReviewEnabled: executionSettings.adversarialReview.enabled,
			adversarialReviewerModel: executionSettings.adversarialReview.model,
			maxRepairAttempts: executionSettings.adversarialReview.maxRepairAttempts,
		});
		const result = await runPreparedExecutionWave(
			this.session,
			runtime,
			prepared,
			executionSettings,
			toolCallId,
			signal,
		);
		const lines = [
			`Execution Wave ${result.waveId}: ${result.status}`,
			...result.lanes.map(
				lane =>
					`- ${lane.laneId} · ${lane.stepId} · ${lane.executor} · ${lane.status}${lane.planImpact && lane.planImpact.level !== "none" ? ` · plan-impact ${lane.planImpact.level}/${lane.planImpact.kind}` : ""}${lane.exitCode === undefined ? "" : ` · exit ${lane.exitCode}`}${lane.error ? ` · ${previewLine(lane.error, TRUNCATE_LENGTHS.LONG)}` : ""}`,
			),
		];
		return { content: [{ type: "text", text: lines.join("\n") }], details: result };
	}
}
