import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Inbox, type InboxTarget } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, MessageId, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { collectDescendantsPostOrder } from '../src/commands.ts'
import { createSessionTestRemote } from './test-remote.ts'

class MockAdapter extends LlmAdapter {
  override providerInfo(): LlmProviderInfo {
    return { id: 'mock-provider', name: 'Mock Provider' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider: 'mock-provider', id: 'mock-chat', name: 'Mock Chat' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // tests do not stream
  }
}

async function setupCascadeHarness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)

  ctx.llm.registerAdapter(['mock-provider'], new MockAdapter())

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

function createMockInbox(): Inbox {
  const nextTurn: UserMessage[] = []
  const nextStep: UserMessage[] = []
  return {
    get nextTurn() { return nextTurn },
    get nextStep() { return nextStep },
    clear: vi.fn(() => { nextTurn.length = 0; nextStep.length = 0 }),
    append: vi.fn((target: InboxTarget, msg: UserMessage) => { (target === 'next-turn' ? nextTurn : nextStep).push(msg) }),
    prepend: vi.fn((target: InboxTarget, msg: UserMessage) => { (target === 'next-turn' ? nextTurn : nextStep).unshift(msg) }),
    replace: vi.fn((id: MessageId, newMsg: UserMessage) => {
      const idx = nextTurn.findIndex(m => m.id === id)
      if (idx >= 0) { nextTurn[idx] = newMsg; return true }
      return false
    }),
    remove: vi.fn((id: MessageId) => {
      const idx = nextTurn.findIndex(m => m.id === id)
      if (idx >= 0) { nextTurn.splice(idx, 1); return true }
      return false
    }),
    splice: vi.fn((target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]) => {
      const list = target === 'next-turn' ? nextTurn : nextStep
      return list.splice(start, deleteCount, ...inserted)
    }),
  }
}

function createMockAgent(ctx: Context, idStr: string): Agent {
  const session = ctx.sessions.create(SessionId(idStr), { meta: { cwd: '/workspace' } })
  return {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: createMockInbox(),
    steer: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as Agent
}

describe('Subagent Cascading Cancellation & Lifecycle Governance', () => {
  it('collects descendants in strict post-order (deepest leaves first) with cycle defense', async () => {
    const { ctx } = await setupCascadeHarness()

    const rootAgent = createMockAgent(ctx, 'tree-root')
    const child1 = createMockAgent(ctx, 'tree-child-1')
    const child2 = createMockAgent(ctx, 'tree-child-2')
    const grandChild1 = createMockAgent(ctx, 'tree-grandchild-1')

    ctx.agents.enter(rootAgent, undefined)
    ctx.agents.announce(rootAgent)

    ctx.agents.enter(child1, rootAgent)
    ctx.agents.announce(child1)

    ctx.agents.enter(child2, rootAgent)
    ctx.agents.announce(child2)

    ctx.agents.enter(grandChild1, child1)
    ctx.agents.announce(grandChild1)

    const descendants = collectDescendantsPostOrder(ctx, rootAgent)

    // Deepest leaf grandChild1 must come before its parent child1!
    expect(descendants).toHaveLength(3)
    const grandChildIdx = descendants.indexOf(grandChild1)
    const child1Idx = descendants.indexOf(child1)
    expect(grandChildIdx).toBeLessThan(child1Idx)
    expect(descendants.indexOf(child2)).toBeGreaterThanOrEqual(0)
  })

  it('recursively cancels all descendant subagents bottom-up when root session is cancelled', async () => {
    const { ctx, remote } = await setupCascadeHarness()

    const rootAgent = createMockAgent(ctx, 'cascade-root')
    const child = createMockAgent(ctx, 'cascade-child')
    const grandchild = createMockAgent(ctx, 'cascade-grandchild')

    ctx.agents.enter(rootAgent, undefined)
    ctx.agents.announce(rootAgent)

    ctx.agents.enter(child, rootAgent)
    ctx.agents.announce(child)

    ctx.agents.enter(grandchild, child)
    ctx.agents.announce(grandchild)

    const cancelCallOrder: string[] = []
    vi.mocked(grandchild.cancel).mockImplementation(() => {
      cancelCallOrder.push('grandchild')
    })
    vi.mocked(child.cancel).mockImplementation(() => {
      cancelCallOrder.push('child')
    })
    vi.mocked(rootAgent.cancel).mockImplementation(() => {
      cancelCallOrder.push('root')
    })

    const cancelResult = await remote.cancel({ sessionId: rootAgent.id })

    expect(cancelResult.ok).toBe(true)

    // Verify cancellation was received by all descendants and root
    expect(grandchild.cancel).toHaveBeenCalledTimes(1)
    expect(grandchild.cancel).toHaveBeenCalledWith({ kind: 'parent' }, { keepInbox: false })

    expect(child.cancel).toHaveBeenCalledTimes(1)
    expect(child.cancel).toHaveBeenCalledWith({ kind: 'parent' }, { keepInbox: false })

    expect(rootAgent.cancel).toHaveBeenCalledTimes(1)
    expect(rootAgent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })

    // Verify bottom-up cancellation sequence: grandchild -> child -> root
    expect(cancelCallOrder).toEqual(['grandchild', 'child', 'root'])
  })

  it('cancelling a leaf subagent only cancels itself, leaving parent and sibling unmolested', async () => {
    const { ctx, remote } = await setupCascadeHarness()

    const root = createMockAgent(ctx, 'branch-root')
    const branchA = createMockAgent(ctx, 'branch-a')
    const branchB = createMockAgent(ctx, 'branch-b')

    ctx.agents.enter(root, undefined)
    ctx.agents.announce(root)

    ctx.agents.enter(branchA, root)
    ctx.agents.announce(branchA)

    ctx.agents.enter(branchB, root)
    ctx.agents.announce(branchB)

    const cancelResult = await remote.cancel({ sessionId: branchA.id })

    expect(cancelResult.ok).toBe(true)
    expect(branchA.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })

    // Root and sibling branchB must remain unmolested
    expect(root.cancel).not.toHaveBeenCalled()
    expect(branchB.cancel).not.toHaveBeenCalled()
  })
})
