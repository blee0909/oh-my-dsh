/**
 * Adversarial TDD Test Suite for Two-Tier Tool Indexing & Turn-Scoped Lifecycle (#5448).
 *
 * Verifies:
 * 1. Tool tier definitions & automatic summary extraction.
 * 2. Token compression via Tier-1 summary catalog vs Tier-2 full schema hydration.
 * 3. Just-In-Time (JIT) auto-hydration when models directly invoke on-demand tools.
 * 4. Explicit activation via `use_tools` meta-tool.
 * 5. Turn-scoped de-activation upon `agent/turn-stopping` event.
 * 6. Quiescent drain barrier protecting in-flight asynchronous tool executions.
 * 7. Strict ScopedLayers isolation between parent and subagent instances.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '../src/index.ts'
import type { ToolDefinition } from '../src/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

const testSignal = new AbortController().signal

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: Scope; key: Agent }> {
  const key = { id: name as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  return { scope, key }
}

function makeCoreTool(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `Core tool ${name}. Always available in wire schemas.`,
    tier: 'core',
    summary: `Core tool_${name} summary`,
    parameters: {
      input: { type: 'string', description: 'Input string' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async args => `core:${name}:${args.input}`,
  })
}

function makeOnDemandTool(name: string, description?: string): ToolDefinition {
  return defineTool({
    name,
    description: description ?? `On-demand tool ${name}. Used for specialized workflows. Detailed parameter instructions.`,
    tier: 'on-demand',
    parameters: {
      query: { type: 'string', description: 'Search or query filter' },
      options: {
        type: 'object',
        additionalProperties: true,
        description: 'Complex nested configuration',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async args => `ondemand:${name}:${args.query}`,
  })
}

describe('Two-tier Tool Schema Indexing (#5448)', () => {
  it('extracts or preserves tool summaries and tiers properly', async () => {
    const explicit = makeCoreTool('tool_explicit')
    expect(explicit.tier).toBe('core')
    expect(explicit.summary).toBe('Core tool_tool_explicit summary')

    const autoSummary = makeOnDemandTool('tool_auto', 'First sentence summary. Second sentence with details.')
    expect(autoSummary.tier).toBe('on-demand')
    expect(autoSummary.summary).toBe('First sentence summary.')
  })

  it('drastically compresses wire schemas by keeping on-demand tools in Tier-1 summary catalog', async () => {
    const ctx = await mount()
    const { key: agent } = await mintAgentScope(ctx, 'agent-1')

    // Register 1 core tool and 5 on-demand tools
    ctx.tools.register(makeCoreTool('core_read'))
    for (let i = 1; i <= 5; i++) {
      ctx.tools.register(makeOnDemandTool(`heavy_tool_${i}`))
    }

    const wire = ctx.tools.wireSchemas(agent)
    // Only the core tool should be populated in wire.schemas
    const wireToolNames = wire.schemas.map(s => s.name)
    expect(wireToolNames).toContain('core_read')
    expect(wireToolNames).not.toContain('heavy_tool_1')
    expect(wireToolNames).not.toContain('heavy_tool_5')

    // But all tools should be present in knownNames so prompt ordering is valid
    expect(wire.knownNames).toContain('core_read')
    expect(wire.knownNames).toContain('heavy_tool_1')

    // Summary catalog should summarize on-demand tools concisely
    const catalog = ctx.tools.summaryCatalog(agent)
    expect(catalog).toContain('heavy_tool_1')
    expect(catalog).toContain('heavy_tool_5')
  })

  it('supports JIT (Just-In-Time) auto-hydration when model directly invokes an on-demand tool', async () => {
    const ctx = await mount()
    const { key: agent } = await mintAgentScope(ctx, 'agent-1')

    ctx.tools.register(makeCoreTool('core_read'))
    ctx.tools.register(makeOnDemandTool('git_blame'))

    // Before invocation, git_blame is not in wire schemas
    expect(ctx.tools.isToolHydrated('git_blame', agent)).toBe(false)
    expect(ctx.tools.wireSchemas(agent).schemas.map(s => s.name)).not.toContain('git_blame')

    // Model directly calls git_blame
    const result = await ctx.tools.execute({
      callId: ToolCallId('call-1'),
      name: 'git_blame',
      arguments: { query: 'HEAD~1' },
      agent,
      signal: testSignal,
    })

    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'ondemand:git_blame:HEAD~1' })

    // After invocation, git_blame is JIT-hydrated in this turn
    expect(ctx.tools.isToolHydrated('git_blame', agent)).toBe(true)
    expect(ctx.tools.wireSchemas(agent).schemas.map(s => s.name)).toContain('git_blame')
  })

  it('supports explicit hydration via use_tools meta-tool', async () => {
    const ctx = await mount()
    const { key: agent } = await mintAgentScope(ctx, 'agent-1')

    ctx.tools.register(makeCoreTool('core_bash'))
    ctx.tools.register(makeOnDemandTool('db_migrate'))

    expect(ctx.tools.isToolHydrated('db_migrate', agent)).toBe(false)

    // Invoke use_tools to activate db_migrate
    const result = await ctx.tools.execute({
      callId: ToolCallId('call-meta'),
      name: 'use_tools',
      arguments: { tools: ['db_migrate'] },
      agent,
      signal: testSignal,
    })

    expect(result.isError).toBe(false)
    expect(ctx.tools.isToolHydrated('db_migrate', agent)).toBe(true)
    expect(ctx.tools.wireSchemas(agent).schemas.map(s => s.name)).toContain('db_migrate')
  })

  it('automatically deactivates turn-leased tools upon agent/turn-stopping', async () => {
    const ctx = await mount()
    const { key: agent } = await mintAgentScope(ctx, 'agent-1')

    ctx.tools.register(makeCoreTool('core_bash'))
    ctx.tools.register(makeOnDemandTool('docker_build'))

    // Hydrate docker_build in current turn
    await ctx.tools.execute({
      callId: ToolCallId('call-docker'),
      name: 'docker_build',
      arguments: { query: '-t my-image .' },
      agent,
      signal: testSignal,
    })

    expect(ctx.tools.isToolHydrated('docker_build', agent)).toBe(true)
    expect(ctx.tools.wireSchemas(agent).schemas.map(s => s.name)).toContain('docker_build')

    // Simulate turn completion
    await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: testSignal })

    // docker_build should be de-activated and removed from wireSchemas
    expect(ctx.tools.isToolHydrated('docker_build', agent)).toBe(false)
    expect(ctx.tools.wireSchemas(agent).schemas.map(s => s.name)).not.toContain('docker_build')
    // Core tool remains untouched
    expect(ctx.tools.wireSchemas(agent).schemas.map(s => s.name)).toContain('core_bash')
  })

  it('protects in-flight asynchronous tool calls with quiescent drain barrier before deactivation', async () => {
    const ctx = await mount()
    const { key: agent } = await mintAgentScope(ctx, 'agent-1')

    let resolveSlowTool!: (value: string) => void
    const slowToolPromise = new Promise<string>((res) => { resolveSlowTool = res })

    const slowTool = defineTool({
      name: 'slow_async_tool',
      description: 'A slow running async on-demand tool',
      tier: 'on-demand',
      parameters: { id: { type: 'string' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async () => slowToolPromise,
    })
    ctx.tools.register(slowTool)

    // Launch slow tool in the background
    const executePromise = ctx.tools.execute({
      callId: ToolCallId('call-slow'),
      name: 'slow_async_tool',
      arguments: { id: 'job-99' },
      agent,
      signal: testSignal,
    })

    // Now slow_async_tool is hydrated and has in-flight count > 0
    expect(ctx.tools.isToolHydrated('slow_async_tool', agent)).toBe(true)

    // Emit turn-stopping while tool is still in-flight
    await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: testSignal })

    // It should NOT be prematurely torn down because it is in-flight draining
    expect(ctx.tools.isToolHydrated('slow_async_tool', agent)).toBe(true)

    // Complete the slow tool
    resolveSlowTool('slow-done')
    const result = await executePromise
    expect(result.content[0]).toEqual({ type: 'text', text: 'slow-done' })

    // Once finished and drained, it safely unloads
    expect(ctx.tools.isToolHydrated('slow_async_tool', agent)).toBe(false)
  })

  it('guarantees strict ScopedLayers isolation between parent agent and subagent', async () => {
    const ctx = await mount()
    const { key: parentAgent } = await mintAgentScope(ctx, 'parent-agent')
    const { key: subAgent } = await mintAgentScope(ctx, 'sub-agent')

    ctx.tools.register(makeCoreTool('core_tool'))
    ctx.tools.register(makeOnDemandTool('secret_subagent_tool'))

    // Subagent hydrates secret_subagent_tool
    await ctx.tools.execute({
      callId: ToolCallId('call-sub'),
      name: 'secret_subagent_tool',
      arguments: { query: 'find-secrets' },
      agent: subAgent,
      signal: testSignal,
    })

    // Subagent has it hydrated; parent agent DOES NOT
    expect(ctx.tools.isToolHydrated('secret_subagent_tool', subAgent)).toBe(true)
    expect(ctx.tools.isToolHydrated('secret_subagent_tool', parentAgent)).toBe(false)
    expect(ctx.tools.wireSchemas(parentAgent).schemas.map(s => s.name)).not.toContain('secret_subagent_tool')

    // Subagent finishes turn and unloads
    await ctx.serial('agent/turn-stopping', { agent: subAgent, turn: 1, signal: testSignal })
    expect(ctx.tools.isToolHydrated('secret_subagent_tool', subAgent)).toBe(false)

    // Parent agent still clean and intact: has core tool, never had secret_subagent_tool
    expect(ctx.tools.wireSchemas(parentAgent).schemas.map(s => s.name)).toContain('core_tool')
    expect(ctx.tools.wireSchemas(parentAgent).schemas.map(s => s.name)).not.toContain('secret_subagent_tool')
  })

  it('guarantees global Symbol.for lookup compatibility across different module copies (#5758)', async () => {
    const ctx = await mount()
    const globalSchedulerSymbol = Symbol.for('@deepseek-ai/dsh-tools.scheduler')

    // Simulate an out-of-bundle or independent package copy referencing ctx.tools using global Symbol.for
    const scheduler = (ctx.tools as unknown as Record<symbol, unknown>)[globalSchedulerSymbol]
    expect(scheduler).toBeDefined()
    expect(typeof (scheduler as { prepare?: unknown }).prepare).toBe('function')
  })
})
