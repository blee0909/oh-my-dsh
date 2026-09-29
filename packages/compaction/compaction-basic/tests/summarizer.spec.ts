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

describe('Compaction Fallback Route and Input Bounding (#7423)', () => {
  it('preserves fallback provider and model in resolveConfig', async () => {
    const { resolveConfig } = await import('../src/config.ts')
    const config = resolveConfig({
      summarizationFallbackProvider: 'fallback-p',
      summarizationFallbackModel: 'fallback-m',
    })
    expect(config.summarizationFallbackProvider).toBe('fallback-p')
    expect(config.summarizationFallbackModel).toBe('fallback-m')
  })

  it('rejects incomplete fallback provider/model pair in resolveConfig', async () => {
    const { resolveConfig } = await import('../src/config.ts')
    expect(() => resolveConfig({ summarizationFallbackProvider: 'fallback-p' }))
      .toThrow('must be set together')
    expect(() => resolveConfig({ summarizationFallbackModel: 'fallback-m' }))
      .toThrow('must be set together')
  })

  it('inherits and overrides fallback provider/model in resolveTargetPolicy', async () => {
    const { resolveConfig, resolveTargetPolicy } = await import('../src/config.ts')
    const config = resolveConfig({
      summarizationFallbackProvider: 'default-fallback-p',
      summarizationFallbackModel: 'default-fallback-m',
      modelPolicies: [
        {
          provider: 'p1',
          model: 'm1',
          summarizationFallbackProvider: 'override-fallback-p',
          summarizationFallbackModel: 'override-fallback-m',
        },
      ],
    })

    const inherited = resolveTargetPolicy(config, { provider: 'p2', model: 'm2' })
    expect(inherited.summarizationFallbackProvider).toBe('default-fallback-p')
    expect(inherited.summarizationFallbackModel).toBe('default-fallback-m')

    const overridden = resolveTargetPolicy(config, { provider: 'p1', model: 'm1' })
    expect(overridden.summarizationFallbackProvider).toBe('override-fallback-p')
    expect(overridden.summarizationFallbackModel).toBe('override-fallback-m')
  })

  it('bounds messages to input budget when surface exceeds context window', async () => {
    const { summarizeWithLlm } = await import('../src/summarizer.ts')
    let capturedOptions: GenerateOptions | undefined

    const mockCtx = {
      llm: {
        resolveModelInfo: async () => ({
          provider: 'small-p',
          id: 'small-m',
          name: 'small-m',
          context: { contextWindow: 2000 },
        }),
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
        requestHeader: () => ({ config: { provider: 'small-p', model: 'small-m' } }),
      },
      options: {},
    }

    const giantText = 'very long content to summarize '.repeat(350)
    await summarizeWithLlm(
      mockCtx as never,
      {
        summarizationProvider: '',
        summarizationModel: '',
        maxTokens: 300,
      },
      {
        messages: [
          {
            id: 'msg-1' as never,
            role: 'user',
            content: [{ type: 'text', text: giantText }],
            source: { kind: 'user' },
          },
        ],
      },
      mockAgent as never,
    )

    expect(capturedOptions).toBeDefined()
    const firstMsg = capturedOptions?.messages[0]
    expect((firstMsg?.content[0] as { text: string }).text.length).toBeLessThan(giantText.length)
  })

  it('migrates to fallback route when primary route encounters context overflow', async () => {
    const { summarizeWithLlm } = await import('../src/summarizer.ts')
    const { CONTEXT_WINDOW_EXCEEDED_CODE } = await import('@deepseek-ai/dsh-llm')
    const streamCalls: GenerateOptions[] = []

    const mockCtx = {
      llm: {
        resolveModelInfo: async (p: string, m: string) => ({
          provider: p,
          id: m,
          name: m,
          context: { contextWindow: p === 'fallback-p' ? 50000 : 2000 },
        }),
        stream: (opts: GenerateOptions) => {
          streamCalls.push(opts)
          return (async function* () {
            if (opts.provider === 'primary-p') {
              yield {
                type: 'finish' as const,
                reason: {
                  kind: 'error' as const,
                  failure: {
                    code: CONTEXT_WINDOW_EXCEEDED_CODE,
                    message: 'context overflow',
                  },
                },
              }
              return
            }
            yield { type: 'text-delta' as const, text: '## Primary Request and Intent\n- Fallback done' }
            yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
          })()
        },
      },
    }

    const mockAgent = {
      session: {
        id: 'test-session',
        requestHeader: () => ({ config: { provider: 'primary-p', model: 'primary-m' } }),
      },
      options: {},
    }

    const result = await summarizeWithLlm(
      mockCtx as never,
      {
        summarizationProvider: '',
        summarizationModel: '',
        summarizationFallbackProvider: 'fallback-p',
        summarizationFallbackModel: 'fallback-m',
        maxTokens: 300,
      },
      { messages: [] },
      mockAgent as never,
    )

    expect(streamCalls).toHaveLength(2)
    expect(streamCalls[0]?.provider).toBe('primary-p')
    expect(streamCalls[1]?.provider).toBe('fallback-p')
    expect(streamCalls[1]?.model).toBe('fallback-m')
    expect(result.provider).toBe('fallback-p')
    expect(result.model).toBe('fallback-m')
  })
})
