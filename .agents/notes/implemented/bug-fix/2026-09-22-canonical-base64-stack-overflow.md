# Agent Note: Eliminate Regex Call Stack Overflow on Large Canonical Base64 Images

Status: implemented

English | [中文](2026-09-22-canonical-base64-stack-overflow.zh.md)

## Problem

In both the Agent Client Protocol (ACP) and the Model Context Protocol (MCP client tools), inline image admission enforces strict RFC 4648 canonical base64 validation to prevent alias exploits, non-canonical encodings, and malformed inputs ([Discussions #7196](https://github.com/deepseek-ai/deepseek-harness/discussions/7196)).

In `packages/acp/acp/src/content.ts` and `packages/mcp/mcp-client/src/tools.ts`, canonical base64 was pre-filtered with:
```ts
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
```
This regular expression employed a greedy outer quantifier wrapping fixed-width groups `(?:...{4})*`. When processing valid, high-resolution images (such as uncompressed screenshots or large diagrams where the base64 string exceeds ~4,473,916 characters / ~3.35MB), the V8 engine exhausted its internal call stack during automaton matching and threw:
```
RangeError: Maximum call stack size exceeded
```
Because this is a fatal runtime exception that bypasses domain validation guards, it caused ACP sessions and MCP tool calls to fail with 502 / Internal errors, rendering large valid images unusable by models.

## Decision

Eliminate recursive call stack growth in regex execution while strictly preserving RFC 4648 canonical base64 guarantees.

1. **Flatten to Linear Regex**: Simplify `CANONICAL_BASE64` to a single-pass linear character pattern without nested repetition:
```ts
/** Canonical RFC 4648 base64 characters, without nested quantifier backtracking. */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
```
2. **Combine with $O(1)$ Length Check**: Validate `block.data.length % 4 !== 0` prior to or alongside regex execution, ensuring proper quad-alignment and padding constraints.
3. **Preserve Native Buffer Round-Trip**: Keep the existing `Buffer.from(data, 'base64').toString('base64') !== data` check intact. Implemented in native C++, this check provides a complete and authoritative guarantee of RFC 4648 canonical conformance and zero unused bits without any stack overhead.

## Alternatives Considered

**Increasing V8 `--stack-size`**. Rejected: Does not address the underlying algorithmic flaw and imposes unnecessary risks and memory overhead across varied deployment environments.

**Removing the Regex Entirely**. Rejected: `CANONICAL_BASE64` acts as an $O(N)$ zero-allocation fast-path rejector that quickly discards payloads with invalid characters, embedded newlines, or URL-safe aliases before allocating buffer memory. The flat linear regex retains this guard with minimal complexity.

## Impact

Benefits:
- Eliminates `RangeError: Maximum call stack size exceeded` crashes when decoding large valid images.
- Unlocks high-resolution image and diagram ingestion across ACP and MCP.
- Reduces regular expression stack complexity strictly to $O(1)$.

Unaffected:
- Rejection behavior and error diagnostics for malformed or non-canonical base64 remain identical.
- Media type constraints (PNG, JPEG, WebP, GIF) and storage quotas remain unchanged.

## Verification

- [`packages/acp/acp/tests/content.spec.ts`](../../../../packages/acp/acp/tests/content.spec.ts): Added test with a 4,473,916-character canonical base64 payload, verifying successful attachment decoding without error.
- [`packages/mcp/mcp-client/tests/mcp-client.spec.ts`](../../../../packages/mcp/mcp-client/tests/mcp-client.spec.ts): Added corresponding test for MCP tool execution admitting large images.
- Test suites: 11 test files (141 tests) in `packages/acp` and 10 test files (148 tests) in `packages/mcp` all pass.
