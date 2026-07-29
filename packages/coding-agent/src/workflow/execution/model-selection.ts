import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";

export const ZZW_CURRENT_SESSION_MODEL = "*";

export interface ZZWSelectableModel {
	provider: string;
	id: string;
	supportedEfforts: readonly Effort[];
}

export interface ZZWExecutionModelSelectors {
	workUnitModel: string;
	adversarialReviewerModel: string;
}

export interface ZZWExecutionModelSelectionInput {
	availableModels: readonly ZZWSelectableModel[];
	activeModel: ZZWSelectableModel | undefined;
	workUnitModel: string;
	adversarialReviewerModel: string;
}

export interface ZZWModelChoice {
	value: string;
	label: string;
	description?: string;
}

export function zzwModelSelector(model: ZZWSelectableModel): string {
	return `${model.provider}/${model.id}`;
}

export function toZZWSelectableModel(model: Model): ZZWSelectableModel {
	return {
		provider: model.provider,
		id: model.id,
		supportedEfforts: getSupportedEfforts(model),
	};
}

function effortSelector(selector: string, effort: Effort): string {
	return `${selector}:${effort}`;
}

function appendModelChoices(
	choices: ZZWModelChoice[],
	seen: Set<string>,
	model: ZZWSelectableModel,
	selector: string,
	label: string,
	description?: string,
): void {
	if (!seen.has(selector)) {
		seen.add(selector);
		choices.push({ value: selector, label: `${label} · 기본 effort`, description });
	}
	for (const effort of model.supportedEfforts) {
		const value = effortSelector(selector, effort);
		if (seen.has(value)) continue;
		seen.add(value);
		choices.push({ value, label: `${label} · ${effort}`, description });
	}
}

export function buildZZWorkflowModelChoices(
	availableModels: readonly ZZWSelectableModel[],
	activeModelSelector?: string,
): ZZWModelChoice[] {
	const seen = new Set<string>();
	const choices: ZZWModelChoice[] = [];
	const activeModel = availableModels.find(model => zzwModelSelector(model) === activeModelSelector);
	if (activeModel) {
		appendModelChoices(
			choices,
			seen,
			activeModel,
			ZZW_CURRENT_SESSION_MODEL,
			"현재 세션 모델",
			`실행 시점의 활성 모델 ${activeModelSelector}을 사용합니다`,
		);
	} else {
		seen.add(ZZW_CURRENT_SESSION_MODEL);
		choices.push({
			value: ZZW_CURRENT_SESSION_MODEL,
			label: "현재 세션 모델 · 기본 effort",
			description: "실행 시점의 현재 활성 모델을 사용합니다",
		});
	}
	for (const model of availableModels) {
		const selector = zzwModelSelector(model);
		appendModelChoices(choices, seen, model, selector, selector);
	}
	return choices;
}

function resolveSelector(
	configured: string,
	available: readonly ZZWSelectableModel[],
	activeModel: ZZWSelectableModel | undefined,
): string {
	const requested = configured.trim() || ZZW_CURRENT_SESSION_MODEL;
	const availableChoices = new Set(
		buildZZWorkflowModelChoices(available)
			.filter(choice => choice.value !== ZZW_CURRENT_SESSION_MODEL)
			.map(choice => choice.value),
	);
	if (requested === ZZW_CURRENT_SESSION_MODEL && !activeModel) {
		throw new Error("현재 세션 모델을 확인할 수 없습니다");
	}
	const selector =
		activeModel && (requested === ZZW_CURRENT_SESSION_MODEL || requested.startsWith(`${ZZW_CURRENT_SESSION_MODEL}:`))
			? `${zzwModelSelector(activeModel)}${requested.slice(ZZW_CURRENT_SESSION_MODEL.length)}`
			: requested;
	if (!availableChoices.has(selector)) {
		throw new Error(`현재 로그인 상태에서 선택할 수 없는 모델 또는 effort입니다: ${selector}`);
	}
	return selector;
}

/**
 * Resolve every ZZW-owned model setting to an exact authenticated selector.
 * Wildcards, role aliases, fuzzy ids, stale models, and unsupported efforts are
 * not accepted: the resulting provider/model[:effort] selector is persisted
 * into the Lane contract.
 */
export function resolveZZWorkflowExecutionModels(input: ZZWExecutionModelSelectionInput): ZZWExecutionModelSelectors {
	if (input.availableModels.length === 0) {
		throw new Error("현재 로그인 상태에서 선택할 수 있는 모델이 없습니다");
	}
	return {
		workUnitModel: resolveSelector(input.workUnitModel, input.availableModels, input.activeModel),
		adversarialReviewerModel: resolveSelector(
			input.adversarialReviewerModel,
			input.availableModels,
			input.activeModel,
		),
	};
}
