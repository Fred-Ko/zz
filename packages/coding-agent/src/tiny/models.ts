/** Default session-title model: the online @smol path (no local download / on-device inference). */
export const ONLINE_TINY_TITLE_MODEL_KEY = "online";
/** Local model the `tiny-models` CLI downloads when none is named. Not the session-title default — that is {@link ONLINE_TINY_TITLE_MODEL_KEY}. */
export const DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY = "lfm2-700m";

export interface TinyTitleLocalModelSpec {
	key: string;
	repo: string;
	dtype: "q4";
	label: string;
	description: string;
	contextNote: string;
	/** Model family emits hidden reasoning unless the chat template disables it. */
	reasoning?: boolean;
	/** Reason this model is blocked before loading the ONNX runtime. */
	unsupportedReason?: string;
}

export const TINY_TITLE_LOCAL_MODELS = [
	{
		key: "lfm2-350m",
		repo: "onnx-community/LFM2-350M-ONNX",
		dtype: "q4",
		label: "LFM2 350M",
		description: "Recommended local model; best speed/quality balance, about 212 MB cached.",
		contextNote: "Best local default from the title-generation spike.",
	},
	{
		key: "qwen3-0.6b",
		repo: "onnx-community/Qwen3-0.6B-ONNX",
		dtype: "q4",
		label: "Qwen3 0.6B",
		description: "Most robust local option; slower first load, about 500 MB cached.",
		contextNote: "Use when title quality matters more than local startup cost.",
		reasoning: true,
	},
	{
		key: "gemma-270m",
		repo: "onnx-community/gemma-3-270m-it-ONNX",
		dtype: "q4",
		label: "Gemma 270M",
		description: "Smallest viable local option; lower quality, lowest cache footprint.",
		contextNote: "Use on constrained machines that still need local titles.",
	},
	{
		key: "qwen2.5-0.5b",
		repo: "onnx-community/Qwen2.5-0.5B-Instruct",
		dtype: "q4",
		label: "Qwen2.5 0.5B",
		description: "Balanced local fallback; moderate quality and cache footprint.",
		contextNote: "Useful when Qwen3 is too heavy but Gemma quality is insufficient.",
	},
	{
		key: "lfm2-700m",
		repo: "onnx-community/LFM2-700M-ONNX",
		dtype: "q4",
		label: "LFM2 700M",
		description: "Highest-quality local option; larger and slower than LFM2 350M.",
		contextNote: "Use when local title quality is preferred over startup cost.",
	},
] as const satisfies readonly TinyTitleLocalModelSpec[];

export const TINY_TITLE_MODEL_VALUES = [
	ONLINE_TINY_TITLE_MODEL_KEY,
	"lfm2-350m",
	"qwen3-0.6b",
	"gemma-270m",
	"qwen2.5-0.5b",
	"lfm2-700m",
] as const;

export type TinyTitleModelKey = (typeof TINY_TITLE_MODEL_VALUES)[number];
export type TinyTitleLocalModelKey = (typeof TINY_TITLE_LOCAL_MODELS)[number]["key"];

type MissingTinyTitleModelValue = Exclude<
	typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey,
	TinyTitleModelKey
>;
type ExtraTinyTitleModelValue = Exclude<TinyTitleModelKey, typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey>;
const TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY: MissingTinyTitleModelValue extends never
	? ExtraTinyTitleModelValue extends never
		? true
		: never
	: never = true;
void TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_TITLE_MODEL_OPTIONS = [
	{
		value: ONLINE_TINY_TITLE_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Online title generation: the TINY model role (set one in /models) when assigned, otherwise the online fallback (commit role, then @smol). No local download or on-device inference.",
	},
	...TINY_TITLE_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyTitleModelKey; label: string; description: string }>;

export function isTinyTitleLocalModelKey(value: string): value is TinyTitleLocalModelKey {
	return TINY_TITLE_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyTitleModelSpec(key: TinyTitleLocalModelKey): (typeof TINY_TITLE_LOCAL_MODELS)[number] {
	const spec = TINY_TITLE_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`Unknown tiny title model: ${key}`);
	return spec;
}

/** Default classifier model: the online path (the configured smol LLM; no local download). */
export const ONLINE_CLASSIFIER_MODEL_KEY = "online";
/** Recommended local classifier model when none is named. */
export const DEFAULT_CLASSIFIER_LOCAL_MODEL_KEY = "lfm2-1.2b";

/**
 * Local models for classification tasks.
 * These are larger than the title models because ordinal classification needs
 * more capacity than short title generation. All q4.
 * Ranking/recipe rationale lives in docs/local-models.md.
 */
export const TINY_CLASSIFIER_LOCAL_MODELS = [
	{
		key: "qwen3-1.7b",
		repo: "onnx-community/Qwen3-1.7B-ONNX",
		dtype: "q4",
		label: "Qwen3 1.7B",
		description:
			"Disabled for local inference: onnxruntime-node cannot run this ONNX export's RotaryEmbedding cache updates.",
		contextNote: "Blocked before load to avoid the unsupported RotaryEmbedding runtime path.",
		reasoning: true,
		unsupportedReason:
			"onnxruntime-node does not support Qwen3 RotaryEmbedding cache updates in onnx-community/Qwen3-1.7B-ONNX",
	},
	{
		key: "llama3.2:3b",
		repo: "onnx-community/Llama-3.2-3B-Instruct-ONNX",
		dtype: "q4",
		label: "Llama 3.2 3B",
		description:
			"Larger Llama 3.2 option for local classifier tasks; higher quality potential at higher disk/RAM/latency cost.",
		contextNote: "Use when larger model capacity is preferred over faster load times.",
	},
	{
		key: "gemma-3-1b",
		repo: "onnx-community/gemma-3-1b-it-ONNX",
		dtype: "q4",
		label: "Gemma 3 1B",
		description: "Compact 1B local classifier with a lower disk and RAM footprint.",
		contextNote: "Use when classifier size matters more than maximum model capacity.",
	},
	{
		key: "qwen2.5-1.5b",
		repo: "onnx-community/Qwen2.5-1.5B-Instruct",
		dtype: "q4",
		label: "Qwen2.5 1.5B",
		description: "Balanced 1.5B local classifier with strong instruction following.",
		contextNote: "Use for a middle ground between footprint and classification capacity.",
	},
	{
		key: "lfm2-1.2b",
		repo: "onnx-community/LFM2-1.2B-ONNX",
		dtype: "q4",
		label: "LFM2 1.2B",
		description: "Recommended local classifier with fast loading and solid ordinal classification.",
		contextNote: "Use when local startup cost and classification quality both matter.",
	},
] as const satisfies readonly TinyTitleLocalModelSpec[];

export const TINY_CLASSIFIER_MODEL_VALUES = [
	ONLINE_CLASSIFIER_MODEL_KEY,
	"qwen3-1.7b",
	"llama3.2:3b",
	"gemma-3-1b",
	"qwen2.5-1.5b",
	"lfm2-1.2b",
] as const;

export type TinyClassifierModelKey = (typeof TINY_CLASSIFIER_MODEL_VALUES)[number];
export type TinyClassifierLocalModelKey = (typeof TINY_CLASSIFIER_LOCAL_MODELS)[number]["key"];

type MissingTinyClassifierModelValue = Exclude<
	typeof ONLINE_CLASSIFIER_MODEL_KEY | TinyClassifierLocalModelKey,
	TinyClassifierModelKey
>;
type ExtraTinyClassifierModelValue = Exclude<
	TinyClassifierModelKey,
	typeof ONLINE_CLASSIFIER_MODEL_KEY | TinyClassifierLocalModelKey
>;
const TINY_CLASSIFIER_MODEL_VALUES_MATCH_REGISTRY: MissingTinyClassifierModelValue extends never
	? ExtraTinyClassifierModelValue extends never
		? true
		: never
	: never = true;
void TINY_CLASSIFIER_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_CLASSIFIER_MODEL_OPTIONS = [
	{
		value: ONLINE_CLASSIFIER_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Use the online model: the TINY role from /models when set, otherwise @smol. No local model download or on-device inference.",
	},
	...TINY_CLASSIFIER_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyClassifierModelKey; label: string; description: string }>;

export function isTinyClassifierLocalModelKey(value: string): value is TinyClassifierLocalModelKey {
	return TINY_CLASSIFIER_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyClassifierModelSpec(
	key: TinyClassifierLocalModelKey,
): (typeof TINY_CLASSIFIER_LOCAL_MODELS)[number] {
	const spec = TINY_CLASSIFIER_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`Unknown tiny classifier model: ${key}`);
	return spec;
}

/** Return whether a classifier model may emit reasoning tokens before answers. */
export function isTinyClassifierReasoningModelKey(key: TinyClassifierLocalModelKey): boolean {
	const spec = getTinyClassifierModelSpec(key);
	return "reasoning" in spec && spec.reasoning === true;
}

/** Any local model key (title or classifier), used by the shared inference worker. */
export type TinyLocalModelKey = TinyTitleLocalModelKey | TinyClassifierLocalModelKey;

/** Resolve a local model spec by key across the title and classifier registries. */
export function getTinyLocalModelSpec(key: string): TinyTitleLocalModelSpec | undefined {
	return (
		TINY_TITLE_LOCAL_MODELS.find(model => model.key === key) ??
		TINY_CLASSIFIER_LOCAL_MODELS.find(model => model.key === key)
	);
}

export function isTinyLocalModelKey(value: string): value is TinyLocalModelKey {
	return getTinyLocalModelSpec(value) !== undefined;
}

/** Combined local model registry (title + classifier) for the shared tiny-models CLI. */
export const TINY_LOCAL_MODELS = [
	...TINY_TITLE_LOCAL_MODELS,
	...TINY_CLASSIFIER_LOCAL_MODELS,
] as const satisfies readonly TinyTitleLocalModelSpec[];

/**
 * Difficulty-classifier model for the `auto` thinking level. Defaults to the
 * online smol path; local options reuse the classifier registry because the
 * shared worker's `complete()` only accepts classifier keys, and the 1B+
 * models classify coding difficulty more reliably than the
 * sub-1B title models.
 */
export const ONLINE_AUTO_THINKING_MODEL_KEY = ONLINE_CLASSIFIER_MODEL_KEY;
export const AUTO_THINKING_MODEL_VALUES = TINY_CLASSIFIER_MODEL_VALUES;
export type AutoThinkingModelKey = TinyClassifierModelKey;

export const AUTO_THINKING_MODEL_OPTIONS = [
	{
		value: ONLINE_AUTO_THINKING_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Classify prompt difficulty online with the TINY role model (set one in /models) or @smol; no local download or on-device inference.",
	},
	...TINY_CLASSIFIER_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: AutoThinkingModelKey; label: string; description: string }>;
