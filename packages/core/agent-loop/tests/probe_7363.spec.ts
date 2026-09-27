import { describe, expect, it } from 'vitest'
import { deriveBrowserTimeZoneContext } from '../../../context/time-context/src/request-zone.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { normalizeUserMessage } from '../src/inbox.ts'

describe('Discussions #7363: bare string and malformed input defense in agent.followup and inbox', () => {
  it('safely handles bare strings and missing sources in deriveBrowserTimeZoneContext without throwing', () => {
    // Defense-in-depth: bare string or missing source safely degrades to missing
    expect(deriveBrowserTimeZoneContext(['a bare string, not a message object' as never])).toEqual({ kind: 'missing' })
    expect(deriveBrowserTimeZoneContext([{ content: [{ type: 'text', text: 'no source' }] } as never])).toEqual({ kind: 'missing' })
    expect(deriveBrowserTimeZoneContext([{ source: undefined } as never])).toEqual({ kind: 'missing' })
  })

  it('normalizes arbitrary inputs via normalizeUserMessage', () => {
    const fromString = normalizeUserMessage('plain prompt')
    expect(fromString.role).toBe('user')
    expect(fromString.content).toEqual([{ type: 'text', text: 'plain prompt' }])
    expect(fromString.source).toEqual({ kind: 'user' })
    expect(typeof fromString.id).toBe('string')

    const fromLooseObject = normalizeUserMessage({ content: 'string content' })
    expect(fromLooseObject.role).toBe('user')
    expect(fromLooseObject.content).toEqual([{ type: 'text', text: 'string content' }])
    expect(fromLooseObject.source).toEqual({ kind: 'user' })

    const fromTextProperty = normalizeUserMessage({ text: 'text property' })
    expect(fromTextProperty.content).toEqual([{ type: 'text', text: 'text property' }])
  })

  it('normalizes bare string in agent.followup() and executes turn successfully', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(timeContext, { timeZone: 'UTC' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const adapter = new MockAdapter([textResponse('reply')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = await ctx.agentLoop.create(SessionId('probe-7363-followup'), { provider: 'mock', model: 'model' })

    // Calling followup with a bare string
    agent.followup('a bare string, not a message object' as never)
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const spliced = events.find(e => e.type === 'agent/inbox/spliced')
    expect(spliced?.data.inserted).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'a bare string, not a message object' }],
        source: { kind: 'user' },
      }),
    ])

    const turnEnd = events.find(e => e.type === 'turn/end')
    expect(turnEnd?.data).toMatchObject({
      reason: {
        kind: 'completed',
      },
    })

    await ctx.fiber.dispose()
  })

  it('normalizes bare string inserted via agent.inbox.splice() and executes successfully', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(timeContext, { timeZone: 'UTC' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const adapter = new MockAdapter([textResponse('reply')])
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = await ctx.agentLoop.create(SessionId('probe-7363-splice'), { provider: 'mock', model: 'model' })

    // Third-party tool or plugin calls inbox.splice directly with a bare string
    agent.inbox.splice('next-turn', 0, 0, ['<a bare string, not a message object>' as never])
    agent.followup('trigger wake' as never)
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const splicedEvents = events.filter(e => e.type === 'agent/inbox/spliced')
    expect(splicedEvents[0]?.data.inserted).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: '<a bare string, not a message object>' }],
        source: { kind: 'user' },
      }),
    ])

    const turnEnd = events.find(e => e.type === 'turn/end')
    expect(turnEnd?.data).toMatchObject({
      reason: {
        kind: 'completed',
      },
    })

    await ctx.fiber.dispose()
  })

  it('recovers legacy durable sessions with bare strings in agent/inbox/spliced via projection', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(timeContext, { timeZone: 'UTC' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const session = ctx.sessions.create(SessionId('legacy-session-with-bare-string'))
    // Append a raw legacy event with a bare string in inserted
    session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: ['legacy bare string from older client' as never],
    })

    const inboxState = ctx.sessionProjections.stateOf(session, 'inbox') as { 'next-turn': readonly unknown[] }
    expect(inboxState?.['next-turn']).toHaveLength(1)
    expect(inboxState?.['next-turn'][0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'legacy bare string from older client' }],
      source: { kind: 'user' },
    })

    await ctx.fiber.dispose()
  })
})
