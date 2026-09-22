# Agent Note: Dollar Math Block Closing Fence

Status: implemented

English | [中文](2026-09-20-dollar-block-closing-fence.zh.md)

## Problem

Assistant replies reach the settled Markdown grammar as model-authored text, and a display formula written as a `$$` block commonly ends its closing fence on the last content line. Upstream `micromark-extension-math` closes that block only when a line starts with `$$`, and it reads the opening line's remainder as the `mathFlowFenceMeta` token, which `mdast-util-math` stores as the math node's `meta` — a field this renderer never reads. That shape therefore had no closing fence anywhere: the call site declared this extension before upstream `math()`, and micromark tries a later extension's constructs first, so upstream's flow construct handled the block and consumed input to the end of the document, and the whole remainder of the reply became one `math` node. KaTeX rejects that node, `renderTexToReact` falls back to its `katex-error` span, and the consumed remainder is never parsed as Markdown again, so the reply loses the formula text on the opening line and displays everything after it as literal source text.

## Decision

[`mathCompatibility.ts`](../../../../packages/client/ui-primitives/src/markdown/mathCompatibility.ts) owns the `$$` block form, and [`parse.ts`](../../../../packages/client/ui-primitives/src/markdown/parse.ts) registers that extension without upstream `math()`.

The dollar flow construct continues across non-lazy line endings, so a fence closes the block at the end of any of its content lines; a closing fence needs at least two `$` and may repeat them regardless of the opening run's length, where upstream instead required the closing run to be at least as long as the opening; a longer opening fence is a block fence only when its line ends after it, so upstream's inline `$$$…$$$` text math keeps working; the opening line's remainder stays formula content instead of becoming `mathFlowFenceMeta`; and a block with no closing fence fails the construct, which leaves its text literal instead of a math node.

A closing-fence attempt that instead meets a fence at the start of its line fails the construct as well: `$$` blocks do not nest, and reading that fence as content rescanned to the end of the document on every later attempt. A mid-line `$$` stays content, because formulas contain it, and the bail must hold on every continued line — including a line that ends an odd backslash run, whose carried-over flag would otherwise skip the next line's closing-fence attempt and with it the bail.

The extension carries upstream's inline-dollar `mathText` construct and not upstream's dollar `mathFlow` construct, so exactly one construct owns `$$` while inline `$…$` keeps upstream's behavior.

If the first settled parse leaves a literal paragraph beginning at a rejected delimiter, `parse.ts` records that source offset and retries with a non-concrete fallback only there. Lists and blockquotes after an unclosed block then use the ordinary flow grammar, while valid math blocks elsewhere keep the concrete construct.

## Alternatives considered

**Keep upstream's `$$` flow construct and repair the resulting math node.** Rejected: the defect is a parse-time outcome. Once the construct has consumed the reply, no renderer-side repair recovers the Markdown structure or the dropped opening line.

**Keep the same-line-only dollar form and bound the consumption instead.** Rejected: it leaves the reported shape unrendered, and a bound without ownership still hands the block to the construct that consumes the document.

**Register upstream `math()` at the call site and remove only its dollar flow.** Rejected: micromark splices a later extension's constructs before an earlier extension's, so the ordering a caller can get wrong is the defect itself; the compatibility extension owns the delimiters it adds.

## Consequences

Gained: the closing-fence shape renders as a display formula, a block with no closing fence degrades to literal text, and malformed delimiters no longer produce one giant math node. The regression test keeps 6 000 repeated unclosed blocks as ordinary paragraphs with no KaTeX output; the timing of that check is intentionally not part of the product contract.

Given up: an upstream info string on the opening line (`$$asciimath`) is formula content rather than `node.meta`, which this renderer never read; and a longer fence whose opening line has content (`$$$x`, then content, then `$$$`) renders as inline text math instead of a display block, where upstream dropped that line's text instead.

Unchanged: headings, tables, and code fences remain ordinary Markdown after a failed math opening. The fallback now also reparses later lists and blockquotes instead of leaving their markers in paragraphs.

## Testing

[`markdown.client.spec.tsx`](../../../../packages/client/ui-primitives/tests/markdown.client.spec.tsx) asserts the multi-line formula value, the fence-run rules, the line-start bail, literal fallback with list and blockquote recovery, and repeated malformed delimiters; [`math-rendering.e2e.ts`](../../../../apps/web/tests/math-rendering.e2e.ts) seeds the closing-fence shape with a table and the reply's done marker after it, and that browser run fails when the parser change is reverted.
