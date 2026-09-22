# Agent Note: Context Overflow on Length Stop with Output Tokens

Status: implemented

English | [中文](2026-09-22-length-stop-one-output-token-overflow.zh.md)

## Problem

When a provider truncates an oversized prompt or runs out of room during generation, it can return a terminal `stopReason: "length"` with a small non-zero output token count (for instance, a single reasoning token like `"The"`).

Upstream `@earendil-works/pi-ai`'s `isContextOverflow` handles length stops with an exact-zero output check:
```js
if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
  const inputTokens = message.usage.input + message.usage.cacheRead;
  if (inputTokens >= contextWindow * 0.99) return true;
}
```
If the provider produces even a single token (`message.usage.output > 0`), this check returns `false`. In `packages/llm/llm-pi-ai/src/stream.ts`, `mapStopReason` then fell through to `case 'length': return { kind: 'max-tokens' }`. Because `agent/request-error` in `compaction-basic` only listens for `CONTEXT_WINDOW_EXCEEDED`, the turn ended normally from the harness's perspective:
- no overflow-recovery compaction was triggered;
- the model produced one token and stopped;
- clicking `continue` repeatedly sent the same 100%+ context window prompt, reproduced the one-token length stop, and trapped the session in an unrecoverable dead loop ([Discussions #7214](https://github.com/deepseek-ai/deepseek-harness/discussions/7214)).

## Decision

Adapter-level overflow classification owns normalizing all provider context-exhaustion outcomes to `CONTEXT_WINDOW_EXCEEDED` (matching `packages/compaction/compaction-basic/README.md`).

In [`stream.ts`](../../../../packages/llm/llm-pi-ai/src/stream.ts), `mapStopReason` introduces a defensive context pressure guard:
```ts
const promptTokens = message.usage
  ? (message.usage.input + (message.usage.cacheRead ?? 0))
  : 0
const lengthOverflow = contextWindow !== undefined
  && message.stopReason === 'length'
  && promptTokens >= contextWindow * 0.99
```
When `promptTokens` fills $\ge 99\%$ of the resolved context window and the response terminates with `stopReason: 'length'`, it is classified as `CONTEXT_WINDOW_EXCEEDED` regardless of whether output is 0, 1, or a tiny run of tokens.

## Alternatives considered

**Wait for upstream `@earendil-works/pi-ai` update.** Rejected: dsh pinned package boundaries and production users on `0.1.6-alpha.2` are actively suffering from dead sessions on long conversations with providers like OpenRouter and DeepSeek. The adapter layer is explicitly designed to maintain provider-specific classification and shield the core agent loop.

**Use `isRecoverableLength(message, desiredMaxOutput)`.** Rejected: `desiredMaxOutput` is an invocation-time request limit that is not tracked on the persisted assistant message or passed into `mapStopReason`. Checking prompt capacity against the resolved context window is a direct, stateless, and authoritative indicator of context exhaustion.

## Consequences

Gained:
- Truncated prompt turns with 1 output token correctly trigger `CONTEXT_WINDOW_EXCEEDED`.
- `compaction-basic` initiates maximal balanced head reduction to reclaim context window space.
- Sessions automatically recover and resume progress on `continue`.

Unchanged:
- Length stops when prompt tokens are below 99% of the window still map to `{ kind: 'max-tokens' }`.
- Provider error messages matching other overflow patterns remain unaffected.

## Testing

- [`convert.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/convert.spec.ts) tests that an assistant message with `stopReason: 'length'`, `output: 1`, and prompt tokens consuming 99% of `contextWindow: 100` maps to `{ kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE } }`.
- Verified all 331 tests across 13 suites in `packages/llm/llm-pi-ai` pass.
- Verified 145 tests in `compaction-basic` pass without regression.
