import { describe, expect, it } from 'vitest'
import {
  ACTIVE_SKILLS_CLOSE_TAG,
  ACTIVE_SKILLS_OPEN_TAG,
  frameSummary,
} from '../src/summarizer.ts'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'

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

describe('Compaction Policy reasoningEffort (#6797)', () => {
  it('leaves reasoningEffort undefined when omitted in resolveConfig', async () => {
    const { resolveConfig } = await import('../src/config.ts')
    const config = resolveConfig({})
    expect(config.reasoningEffort).toBeUndefined()
  })

  it('preserves custom reasoningEffort in resolveConfig', async () => {
    const { resolveConfig } = await import('../src/config.ts')
    const config = resolveConfig({ reasoningEffort: 'low' })
    expect(config.reasoningEffort).toBe('low')
  })

  it('inherits and overrides reasoningEffort in resolveTargetPolicy', async () => {
    const { resolveConfig, resolveTargetPolicy } = await import('../src/config.ts')
    const config = resolveConfig({
      modelPolicies: [
        { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
      ],
    })

    const defaultPolicy = resolveTargetPolicy(config, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(defaultPolicy.reasoningEffort).toBeUndefined()

    const overriddenPolicy = resolveTargetPolicy(config, { provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(overriddenPolicy.reasoningEffort).toBe('high')
  })

  it('summarizeWithLlm omits reasoningEffort by default and retains purpose compaction', async () => {
    const { summarizeWithLlm } = await import('../src/summarizer.ts')
    let capturedOptions: GenerateOptions | undefined

    const mockCtx = {
      llm: {
        stream: (opts: GenerateOptions) => {
          capturedOptions = opts
          return (async function* () {
            yield { type: 'text-delta' as const, text: '## Primary Request and Intent\n- Done' }
            yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
          })()
        },
      },
    }

    const mockAgent = {
      session: {
        id: 'test-session',
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-reasoner' } }),
      },
      options: {},
    }

    await summarizeWithLlm(
      mockCtx as never,
      {
        summarizationProvider: '',
        summarizationModel: '',
        maxTokens: 8192,
      },
      { messages: [] },
      mockAgent as never,
    )

    expect(capturedOptions).toBeDefined()
    expect(capturedOptions?.purpose).toBe('compaction')
    expect(capturedOptions?.reasoningEffort).toBeUndefined()
  })

  it('summarizeWithLlm passes explicit reasoningEffort to GenerateOptions', async () => {
    const { summarizeWithLlm } = await import('../src/summarizer.ts')
    const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
    let capturedOptions: GenerateOptions | undefined

    const mockCtx = {
      llm: {
        stream: (opts: GenerateOptions) => {
          capturedOptions = opts
          return (async function* () {
            yield { type: 'text-delta' as const, text: '## Primary Request and Intent\n- Done' }
            yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
          })()
        },
      },
    }

    const mockAgent = {
      session: {
        id: 'test-session',
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-reasoner' } }),
      },
      options: {},
    }

    await summarizeWithLlm(
      mockCtx as never,
      {
        summarizationProvider: '',
        summarizationModel: '',
        maxTokens: 8192,
        reasoningEffort: ReasoningEffortId('off'),
      },
      { messages: [] },
      mockAgent as never,
    )

    expect(capturedOptions).toBeDefined()
    expect(capturedOptions?.purpose).toBe('compaction')
    expect(capturedOptions?.reasoningEffort).toBe('off')
  })
})
