# Embedded Local Tiny Models

ZZ uses optional local ONNX models for two bounded tasks:

- session title generation through `providers.tinyModel`
- automatic thinking-level classification through `providers.autoThinkingModel`

Both default to `online`, so no model is downloaded unless the user opts in. ZZ Knowledge does not use these models; durable knowledge extraction and synthesis belong to Hindsight behind the independent Knowledge wrapper.

## Runtime

- `@huggingface/transformers` runs with Bun and `onnxruntime-node`.
- Local inference runs in the shared tiny worker, outside the TUI thread.
- Models use q4 by default.
- `providers.tinyModelDevice` or `PI_TINY_DEVICE` selects the execution provider.
- `providers.tinyModelDtype` or `PI_TINY_DTYPE` selects precision.
- The first run downloads weights to the model cache; later runs reuse them.

## Session title models

The title task turns the first user message into a short label. The runtime uses a title tag prefill, greedy decoding, and a closing-tag stop sequence.

Available local keys:

```text
lfm2-350m
qwen3-0.6b
gemma-270m
qwen2.5-0.5b
lfm2-700m
```

`lfm2-350m` is the smallest recommended local option. The CLI download default is `lfm2-700m`; the runtime setting default remains `online`.

## Thinking classifier models

The classifier maps a coding request to a reasoning-effort level when thinking is set to `auto`.

Available local keys:

```text
qwen3-1.7b
llama3.2:3b
gemma-3-1b
qwen2.5-1.5b
lfm2-1.2b
```

`lfm2-1.2b` is the recommended local classifier default. `qwen3-1.7b` remains listed for configuration compatibility but is rejected before local load because its ONNX RotaryEmbedding cache update is unsupported by the current runtime.

## Commands

```sh
zz tiny-models list
zz tiny-models download lfm2-700m
zz tiny-models download lfm2-1.2b
```

Use `zz config list` for the current setting values and supported device/dtype enums.
