// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import type { Root, Delete } from 'mdast'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGfm, parseGfmWithMath } from '../src/markdown/parse.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

function collectDeleteNodes(node: Root | Delete | { children?: unknown[] }): Delete[] {
  const deletes: Delete[] = []
  if ('type' in node && node.type === 'delete') {
    deletes.push(node as Delete)
  }
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      deletes.push(...collectDeleteNodes(child as Root | Delete))
    }
  }
  return deletes
}

describe('Markdown strikethrough parsing (Discussions #6907)', () => {
  it('does not parse single tildes as delete nodes in parseGfm', () => {
    const ast = parseGfm('区间 ~100~ 到 ~200~ 之间')
    const deletes = collectDeleteNodes(ast)
    expect(deletes).toHaveLength(0)
  })

  it('does not parse single tildes as delete nodes in parseGfmWithMath', () => {
    const ast = parseGfmWithMath('区间 ~100~ 到 ~200~ 之间')
    const deletes = collectDeleteNodes(ast)
    expect(deletes).toHaveLength(0)
  })

  it('preserves double tilde strikethrough in both parsing arms', () => {
    const text = 'This is ~~strikethrough~~ text.'
    const ast1 = parseGfm(text)
    const ast2 = parseGfmWithMath(text)

    const del1 = collectDeleteNodes(ast1)
    const del2 = collectDeleteNodes(ast2)

    expect(del1).toHaveLength(1)
    expect(del2).toHaveLength(1)
    expect(del1[0]?.children[0]).toMatchObject({ type: 'text', value: 'strikethrough' })
    expect(del2[0]?.children[0]).toMatchObject({ type: 'text', value: 'strikethrough' })
  })

  it('handles mixed single and double tilde expressions independently', () => {
    const text = '保留 ~alpha~ 但 ~~删除beta~~ 并且 ~gamma~'
    const ast = parseGfmWithMath(text)
    const deletes = collectDeleteNodes(ast)

    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.children[0]).toMatchObject({ type: 'text', value: '删除beta' })
  })

  it('renders single tildes as literal text in DOM without <del> element', () => {
    const { container } = render(<MarkdownText text="区间 ~100~ 到 ~200~ 之间" />)
    const dels = container.querySelectorAll('del')
    expect(dels).toHaveLength(0)
    expect(container.textContent).toContain('区间 ~100~ 到 ~200~ 之间')
  })

  it('renders double tildes as semantic <del> element in DOM', () => {
    const { container } = render(<MarkdownText text="Hello ~~deleted~~ world" />)
    const dels = container.querySelectorAll('del')
    expect(dels).toHaveLength(1)
    expect(dels[0]?.textContent).toBe('deleted')
  })

  it('treats unequal tilde pairs as literal text', () => {
    const text = 'Literal ~a~~ and ~~b~~~ expressions'
    const ast = parseGfmWithMath(text)
    const deletes = collectDeleteNodes(ast)
    expect(deletes).toHaveLength(0)
  })
})
