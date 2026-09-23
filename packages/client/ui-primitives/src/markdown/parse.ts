/**
 * The markdown renderer's two mdast grammars, one per rendering arm. Each
 * arm is internally consistent — the incremental tail parses, the one-shot
 * parses, and the plain-text projection of a given grammar always agree on
 * where blocks start and end — and the settled grammar is the streaming one
 * plus the math extensions, so the arms differ only where TeX delimiters
 * begin a math construct (a closed `$$` block is a paragraph while streaming
 * and a math block once settled, by design; a block that never closes stays
 * literal text while ordinary Markdown after its failed opening is reparsed
 * with the normal flow grammar).
 */

import type { Root, RootContent } from 'mdast'
import { recoverLocalImages } from './local-image-syntax.ts'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { cjkFriendlyStrong } from './cjkFriendlyStrong.ts'
import { mathCompatibility } from './mathCompatibility.ts'

/**
 * Parse GFM markdown (the streaming arm's grammar: no math, so incomplete
 * TeX never flashes KaTeX errors mid-stream).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfm(text: string): Root {
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [gfm({ singleTilde: false }), cjkFriendlyStrong()],
    mdastExtensions: [gfmFromMarkdown()],
  }), text)
}

/**
 * Parse GFM markdown plus TeX math with the compatibility delimiters
 * (the settled arm's grammar).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfmWithMath(text: string): Root {
  const root = fromMarkdown(text, {
    extensions: [gfm({ singleTilde: false }), cjkFriendlyStrong(), mathCompatibility()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  const fallbackOffsets = findUnclosedMathOffsets(root, text)
  if (fallbackOffsets.size === 0) return recoverLocalImages(root, text)
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [gfm({ singleTilde: false }), cjkFriendlyStrong(), mathCompatibility({ fallbackOffsets })],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }), text)
}

/**
 * Locate literal paragraphs that begin where the settled math grammar rejected
 * an unclosed flow construct. A second parse can then let ordinary Markdown
 * flow constructs interrupt that known fallback without changing valid math.
 * @param root - The first settled parse.
 * @param source - The original Markdown source.
 * @returns Source offsets that need the non-concrete fallback.
 */
function findUnclosedMathOffsets(root: Root, source: string): Set<number> {
  const offsets = new Set<number>()

  function visit(node: Root | RootContent): void {
    if (node.type === 'paragraph') {
      const first = node.children[0]
      const offset = first?.position?.start.offset
      if (first?.type === 'text' && offset !== undefined
        && (source.startsWith('$$', offset) || source.startsWith('\\[', offset))) {
        offsets.add(offset)
      }
    }
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }

  visit(root)
  return offsets
}
