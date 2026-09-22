# Agent Note: 伴随输出 Token 的 Length Stop 上下文溢出识别

状态：已实现

[English](2026-09-22-length-stop-one-output-token-overflow.md) | 中文

## 问题

当模型提供方截断超大 prompt 或在生成过程中耗尽上下文空间时，可能会返回终止状态 `stopReason: "length"` 并伴随极少量的非零输出 token（例如仅输出一个思考标记 `"The"`）。

上游 `@earendil-works/pi-ai` 的 `isContextOverflow` 针对 length 停止硬编码了严格为零的输出判定：
```js
if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
  const inputTokens = message.usage.input + message.usage.cacheRead;
  if (inputTokens >= contextWindow * 0.99) return true;
}
```
若提供方产出了哪怕 1 个 token（`message.usage.output > 0`），该检测即返回 `false`。在 `packages/llm/llm-pi-ai/src/stream.ts` 中，`mapStopReason` 随后回退到 `case 'length': return { kind: 'max-tokens' }`。由于 `compaction-basic` 中的 `agent/request-error` 仅监听 `CONTEXT_WINDOW_EXCEEDED`，从 Harness 的视角看，该轮会话正常结束：
- 未触发任何溢出恢复压缩；
- 模型产出 1 个 token 后戛然而止；
- 用户点击 `continue` 反复重放完全相同（且已占满 100%+ 上下文窗口）的超大 prompt，再次产生 1 个 token 后以 length 截断，使会话陷入无法自愈的永久死循环（[Discussions #7214](https://github.com/deepseek-ai/deepseek-harness/discussions/7214)）。

## 决策

溢出分类属于适配器职责，负责将所有可识别的提供方上下文耗尽结果规范化为 `CONTEXT_WINDOW_EXCEEDED`（与 `packages/compaction/compaction-basic/README.zh.md` 架构契约对齐）。

在 [`stream.ts`](../../../../packages/llm/llm-pi-ai/src/stream.ts) 中，`mapStopReason` 引入了防御性上下文压力守卫：
```ts
const promptTokens = message.usage
  ? (message.usage.input + (message.usage.cacheRead ?? 0))
  : 0
const lengthOverflow = contextWindow !== undefined
  && message.stopReason === 'length'
  && promptTokens >= contextWindow * 0.99
```
当 `promptTokens` 消耗达到已解析上下文窗口的 $\ge 99\%$ 且响应以 `stopReason: 'length'` 终止时，无论输出 token 是 0、1 还是极少量，均统一分类为 `CONTEXT_WINDOW_EXCEEDED`。

## 权衡与替代方案

**等待上游 `@earendil-works/pi-ai` 更新**。否决：dsh 锁定了依赖版本范围，且运行在 `0.1.6-alpha.2` 上的生产用户正因 OpenRouter/DeepSeek 等提供方的死锁会话严重受阻。适配器层在架构上就是为了承载提供方特定分类与屏蔽底层差异而设计的。

**使用 `isRecoverableLength(message, desiredMaxOutput)`**。否决：`desiredMaxOutput` 是调用时的请求限制，未在持久化 assistant message 上记录，亦未传递给 `mapStopReason`。依据已解析上下文窗口比对 prompt 容量是直接、无状态且权威的上下文耗尽指标。

## 影响与收益

收益：
- 伴随 1 个输出 token 的超大 prompt 截断轮次能正确触发 `CONTEXT_WINDOW_EXCEEDED`。
- `compaction-basic` 立即启动最大平衡头部裁剪，回收上下文窗口空间。
- 用户点击 `continue` 后会话自动恢复并顺利前进。

未受影响部分：
- 当 prompt token 未达到窗口 99% 时的正常 length 停止仍然映射为 `{ kind: 'max-tokens' }`。
- 匹配其他溢出正则模式的提供方报错不受任何影响。

## 验证

- [`convert.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/convert.spec.ts) 验证了 `stopReason: 'length'`、`output: 1` 且 prompt 消耗达到 `contextWindow: 100` 的 99% 时正确映射到 `{ kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE } }`。
- 验证了 `packages/llm/llm-pi-ai` 13 个套件共 331 个测试全部通过。
- 验证了 `compaction-basic` 145 个测试全部通过，无退化。
