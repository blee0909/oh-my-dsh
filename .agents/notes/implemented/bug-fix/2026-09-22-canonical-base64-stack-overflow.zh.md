# Agent Note: 消除大图合法 Canonical Base64 正则匹配引发的调用栈溢出

状态：已实现

[English](2026-09-22-canonical-base64-stack-overflow.md) | 中文

## 问题

在 Agent 通信协议（ACP）与模型上下文协议（MCP 客户端工具）中，内联图片接入需经过严格的 RFC 4648 规范 Base64 校验，以防止恶意注入、别名伪造和非规范编码（[Discussions #7196](https://github.com/deepseek-ai/deepseek-harness/discussions/7196)）。

在 `packages/acp/acp/src/content.ts` 与 `packages/mcp/mcp-client/src/tools.ts` 中，规范 Base64 的预检正则定义为：
```ts
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
```
该正则使用了外层贪婪量词嵌套定长捕获组 `(?:...{4})*`。当处理分辨率较高、体积较大的合法图片（例如未压缩的高清截图或长图，Base64 字符串长度达到 4,473,916 字符 / 约 3.35MB 及以上）时，V8 JavaScript 引擎在执行非确定性有限自动机/回溯栈展开时耗尽调用栈，抛出：
```
RangeError: Maximum call stack size exceeded
```
由于该异常属于致命运行时错误且越过了业务级的参数格式校验捕获，直接导致 ACP / MCP 内部崩溃（向客户端返回 502 / Internal error），合法大图完全无法被模型消费。

## 决策

在保证 RFC 4648 规范性约束不降级的前提下，消除嵌套量词正则引发的深层调用栈消耗。

1. **扁平化线性正则**：将 `CANONICAL_BASE64` 优化为无嵌套分组的单层线性字符集匹配：
```ts
/** Canonical RFC 4648 base64 characters, without nested quantifier backtracking. */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
```
2. **结合 $O(1)$ 长度与整除守卫**：在调用正则前预先检验 `block.data.length % 4 !== 0`，确保规范 Base64 长度为 4 的整数倍且末尾等号不超过 2 个。
3. **保留回环权威校验**：保持紧随其后的 `Buffer.from(data, 'base64').toString('base64') !== data` 不变。作为 Node.js 原生 C++ 实现，该校验具备严格的无偏位与 RFC 4648 规范性充要验证能力，性能极高且无栈溢出风险。

## 权衡与替代方案

**调整 V8 `--stack-size` 启动参数**。否决：无法从根本上消除算法级缺陷，且对嵌入式 Node.js 运行时或多环境部署存在不可控风险与内存损耗。

**完全废除正则，纯依赖 `Buffer` 回环**。否决：`CANONICAL_BASE64` 作为前置快速拒绝过滤器（Fast-Path Rejector），能够以 $O(N)$ 零内存分配开销剔除含有非法字符、换行符或 URL-Safe 别名的畸变输入，避免无意义的大块内存分配。保留线性正则在工程防线与性能上达到最优平衡。

## 影响与收益

收益：
- 完全消除了处理 3MB+ 及超大图片 Base64 时的 `RangeError: Maximum call stack size exceeded` 崩溃。
- ACP 与 MCP 图片工具对高清长图、高分屏截屏的接纳能力得到完全保障。
- 正则匹配复杂度严格恒定为 $O(N)$ 线性扫描，调用栈空间消耗降为 $O(1)$。

未受影响部分：
- 对非规范 Base64（如缺失补位 `=`、包含空格或换行、非零剩余位）的拒绝行为与错误消息完全一致。
- 图片格式约束（PNG/JPEG/WebP/GIF）与存储容量配额契约完全保持不变。

## 验证

- [`packages/acp/acp/tests/content.spec.ts`](../../../../packages/acp/acp/tests/content.spec.ts)：增加 4,473,916 字符的大图测试用例，确证大图在 ACP 中被稳定解码为附件。
- [`packages/mcp/mcp-client/tests/mcp-client.spec.ts`](../../../../packages/mcp/mcp-client/tests/mcp-client.spec.ts)：增加对应的大图 MCP 工具执行用例，确证成功接入与持久化，无调用栈溢出。
- 全套测试：`packages/acp` 11 个套件 141 个测试全部通过；`packages/mcp` 10 个套件 148 个测试全部通过。
