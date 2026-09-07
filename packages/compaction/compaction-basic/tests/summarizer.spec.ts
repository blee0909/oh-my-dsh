import { describe, expect, it } from 'vitest'
import {
  ACTIVE_SKILLS_CLOSE_TAG,
  ACTIVE_SKILLS_OPEN_TAG,
  frameSummary,
} from '../src/summarizer.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

describe('Mark-Compact-Rehydrate Summarizer (#5766)', () => {
  it('frames summary without activeSkills in standard format', () => {
    const summary: ContentBlock[] = [
      { type: 'text', text: '## Primary Request and Intent\n- Fix bugs' },
    ]
    const framed = frameSummary(summary)
    expect(framed).toHaveLength(3)
    expect(framed[0]!.type).toBe('text')
    if (framed[0]!.type === 'text') {
      expect(framed[0]!.text).toContain('<compacted-summary>')
    }
    expect(framed[1]).toEqual(summary[0])
    expect(framed[2]!.type).toBe('text')
    if (framed[2]!.type === 'text') {
      expect(framed[2]!.text).toBe('</compacted-summary>')
    }
  })

  it('injects <active-skills> block when activeSkills are provided', () => {
    const summary: ContentBlock[] = [
      { type: 'text', text: '## Primary Request and Intent\n- Run analysis' },
    ]
    const activeSkills = ['qa-gatekeeper', 'research-assistant']
    const framed = frameSummary(summary, activeSkills)

    expect(framed).toHaveLength(4)
    const skillsBlock = framed[3]!
    expect(skillsBlock.type).toBe('text')
    if (skillsBlock.type === 'text') {
      expect(skillsBlock.text).toContain(ACTIVE_SKILLS_OPEN_TAG)
      expect(skillsBlock.text).toContain('- qa-gatekeeper')
      expect(skillsBlock.text).toContain('- research-assistant')
      expect(skillsBlock.text).toContain(ACTIVE_SKILLS_CLOSE_TAG)
    }
  })

  it('omits <active-skills> block when activeSkills array is empty', () => {
    const summary: ContentBlock[] = [
      { type: 'text', text: 'Summary' },
    ]
    const framed = frameSummary(summary, [])
    expect(framed).toHaveLength(3)
    for (const block of framed) {
      if (block.type === 'text') {
        expect(block.text).not.toContain(ACTIVE_SKILLS_OPEN_TAG)
      }
    }
  })
})
