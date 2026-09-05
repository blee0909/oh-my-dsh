/**
 * Action-Level RBAC & Steering Protocol tests for Subagents.
 *
 * Verifies:
 * 1. Ordinary prompt rejection (data-plane isolation protects parent orchestration).
 * 2. Model selection allowance (control-plane governance allows dynamic model switching).
 * 3. Cold subagent penetration (offline cold subagents can be resumed for governance without ownership rejection).
 * 4. Urgent steering allowance (mode === 'steer' prompt and updateQueue with steer kind bypass subagent block).
 * 5. Controlled cancellation allowance (cancel terminates subagent execution cleanly).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote, installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

let nextRequestId = 1
function promptRequest(
  payload: Omit<SessionPromptRequest, 'requestId'>,
): SessionPromptRequest {
  return {
    ...payload,
    requestId: `subagent-rbac-${String(nextRequestId++)}` as SessionRequestId,
  }
}

class MockAdapter extends LlmAdapter {
  constructor(
    private readonly provider: string,
    private readonly models: readonly LlmModelInfo[],
    private readonly reasoning?: LlmModelReasoningInfo,
  ) {
    super()
  }

  override providerInfo(): LlmProviderInfo {
    return { id: this.provider, name: 'Mock Provider' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }),
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // tests do not stream
  }
}

const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

async function setupRbacHarness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)

  ctx.llm.registerAdapter(['mock-provider'], new MockAdapter('mock-provider', [
    { provider: 'mock-provider', id: 'mock-chat', name: 'Mock Chat' },
    { provider: 'mock-provider', id: 'mock-reasoner', name: 'Mock Reasoner' },
  ], REASONING))

  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock-provider', model: 'mock-chat' }),
    saveSelection: () => Promise.resolve(),
  } as never)

  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
  } as never)

  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1000,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 10000,
      maxImagePixels: 1000000,
      maxImageDimension: 1000,
      mediaTypes: ['image/png'],
    },
    admitPromptContent: (_parts: unknown) => Promise.resolve([]),
  } as never)

  const remote = createSessionTestRemote(ctx, {
    cwd: '/workspace',
    defaultModelSelection: () => ({ provider: 'mock-provider', model: 'mock-chat' }),
  })
  return { ctx, remote }
}

describe('Subagent Action-Level RBAC and Steering', () => {
  it('rejects ordinary data-plane prompt on subagent session with session/agent-busy', async () => {
    const { ctx, remote } = await setupRbacHarness()
    const parentSession = ctx.sessions.create(SessionId('parent-session'), { meta: { cwd: '/workspace' } })
    const childSession = ctx.sessions.create(SessionId('child-session'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSession.id },
    })

    const childAgent = {
      id: childSession.id,
      session: childSession,
      status: 'running',
      ctx,
      inbox: new Inbox(childSession, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      steer: vi.fn(),
      followup: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Agent
    ctx.agents.register(childAgent)

    const promptResult = await remote.prompt(promptRequest({
      sessionId: childSession.id,
      mode: 'queue',
      content: [{ type: 'text', text: 'ordinary user prompt' }],
    }))

    expect(promptResult.ok).toBe(false)
    if (!promptResult.ok) {
      expect(promptResult.error.code).toBe('session/agent-busy')
      expect(promptResult.error.message).toContain('owned by subagent routing')
    }
  })

  it('allows model selection (selectModel) on live subagent session and records model/selection event', async () => {
    const { ctx, remote } = await setupRbacHarness()
    const parentSession = ctx.sessions.create(SessionId('parent-session-2'), { meta: { cwd: '/workspace' } })
    const childSession = ctx.sessions.create(SessionId('child-session-2'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSession.id },
    })

    const childAgent = {
      id: childSession.id,
      session: childSession,
      status: 'running',
      ctx,
      inbox: new Inbox(childSession, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      steer: vi.fn(),
      followup: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Agent
    ctx.agents.register(childAgent)

    const selectResult = await remote.selectModel({
      sessionId: childSession.id,
      provider: 'mock-provider',
      model: 'mock-reasoner',
      reasoningEffort: 'high',
    })

    expect(selectResult.ok).toBe(true)
    if (selectResult.ok) {
      expect(selectResult.value.selected).toEqual({
        provider: 'mock-provider',
        model: 'mock-reasoner',
        reasoningEffort: ReasoningEffortId('high'),
      })
    }

    // Verify model/selection event was durably appended to session log
    const events = childSession.snapshotEvents()
    const selectionEvent = events.find(e => e.type === 'model/selection')
    expect(selectionEvent).toBeDefined()
    expect(selectionEvent?.data).toMatchObject({
      provider: 'mock-provider',
      model: 'mock-reasoner',
    })
  })

  it('allows model selection on cold/offline subagent session via penetration resume', async () => {
    const { ctx, remote } = await setupRbacHarness()
    const coldSessionId = SessionId('cold-subagent')
    const header: SessionHeader = {
      version: 0,
      id: coldSessionId,
      createdAt: 100,
      isSeeded: false,
      origin: 'subagent',
      parentSession: SessionId('parent-session-cold'),
      cwd: '/workspace',
    }

    // Session is persisted cold, not currently live in ctx.agents
    installSessionReadTestServices(ctx)
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({
        meta: header,
        inheritedEventCount: SessionLogOffset(0),
        events: [],
      }),
    }) as never)

    // Agent is NOT registered in memory (cold)
    expect(ctx.agents.get(coldSessionId)).toBeUndefined()

    const childSession = ctx.sessions.create(coldSessionId, {
      meta: { cwd: '/workspace', parentSession: SessionId('parent-session-cold'), origin: 'subagent' },
    })
    const resumedAgent = {
      id: coldSessionId,
      session: childSession,
      status: 'idle',
      ctx,
      inbox: new Inbox(childSession, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    } as unknown as Agent
    vi.spyOn(ctx.agents, 'resume').mockResolvedValueOnce({ agent: resumedAgent } as never)

    const selectResult = await remote.selectModel({
      sessionId: coldSessionId,
      provider: 'mock-provider',
      model: 'mock-reasoner',
    })

    expect(selectResult.ok).toBe(true)
    if (selectResult.ok) {
      expect(selectResult.value.selected).toMatchObject({
        provider: 'mock-provider',
        model: 'mock-reasoner',
      })
    }
  })

  it('allows urgent steering (prompt mode === steer) on subagent session', async () => {
    const { ctx, remote } = await setupRbacHarness()
    const parentSession = ctx.sessions.create(SessionId('parent-session-3'), { meta: { cwd: '/workspace' } })
    const childSession = ctx.sessions.create(SessionId('child-session-3'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSession.id },
    })

    const steerFn = vi.fn()
    const childAgent = {
      id: childSession.id,
      session: childSession,
      status: 'running',
      ctx,
      inbox: new Inbox(childSession, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      steer: steerFn,
      followup: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Agent
    ctx.agents.register(childAgent)

    const promptResult = await remote.prompt(promptRequest({
      sessionId: childSession.id,
      content: [{ type: 'text', text: 'urgent steer directive' }],
      mode: 'steer',
    }))

    expect(promptResult.ok).toBe(true)
    expect(steerFn).toHaveBeenCalledOnce()
    const calledMessage = steerFn.mock.calls[0]?.[0]
    expect(calledMessage.content[0]?.text).toBe('urgent steer directive')
  })

  it('allows queue steering mutation (updateQueue steer) on subagent session', async () => {
    const { ctx, remote } = await setupRbacHarness()
    const parentSession = ctx.sessions.create(SessionId('parent-session-4'), { meta: { cwd: '/workspace' } })
    const childSession = ctx.sessions.create(SessionId('child-session-4'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSession.id },
    })

    const inbox = new Inbox(childSession, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
    const queuedMessage = createUserMessage({ content: [{ type: 'text', text: 'queued in turn' }], source: { kind: 'user' } })
    inbox.append('next-turn', queuedMessage)

    const steerFn = vi.fn()
    const childAgent = {
      id: childSession.id,
      session: childSession,
      status: 'running',
      ctx,
      inbox,
      steer: steerFn,
      followup: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Agent
    ctx.agents.register(childAgent)

    const updateResult = await remote.updateQueue({
      sessionId: childSession.id,
      itemId: queuedMessage.id,
      action: { kind: 'steer' },
    })

    expect(updateResult.ok).toBe(true)
    expect(steerFn).toHaveBeenCalledOnce()
  })

  it('allows controlled cancellation (cancel) on live subagent session', async () => {
    const { ctx, remote } = await setupRbacHarness()
    const parentSession = ctx.sessions.create(SessionId('parent-session-5'), { meta: { cwd: '/workspace' } })
    const childSession = ctx.sessions.create(SessionId('child-session-5'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSession.id },
    })

    const cancelFn = vi.fn()
    const childAgent = {
      id: childSession.id,
      session: childSession,
      status: 'running',
      ctx,
      inbox: new Inbox(childSession, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      steer: vi.fn(),
      followup: vi.fn(),
      cancel: cancelFn,
    } as unknown as Agent
    ctx.agents.register(childAgent)

    const cancelResult = await remote.cancel({
      sessionId: childSession.id,
    })

    expect(cancelResult.ok).toBe(true)
    expect(cancelFn).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })
})
