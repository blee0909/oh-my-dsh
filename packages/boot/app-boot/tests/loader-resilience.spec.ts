import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dirs: string[] = []
function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-resilience-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Loader fault tolerance & in-place isolation (#6134)', () => {
  it('tolerates broken plugins when tolerateEntryFailures is true without rolling back healthy entries', async () => {
    const dir = createTempDir()
    const baseUrl = pathToFileURL(dir).href + '/'

    writeFileSync(join(dir, 'healthy1.mjs'), [
      'export const name = "healthy1"',
      'export function apply(ctx) {',
      '  ctx.provide("service1", { active: true })',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'broken.mjs'), [
      'export const name = "broken"',
      'export function apply() {',
      '  throw new Error("Broken third-party plugin crashed during apply")',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'healthy2.mjs'), [
      'export const name = "healthy2"',
      'export function apply(ctx) {',
      '  ctx.provide("service2", { active: true })',
      '}',
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = baseUrl
    await ctx.plugin(Loader, {
      baseUrl,
      tolerateEntryFailures: true,
    })

    const failedEvents: Array<{ id: string; name: string; error: unknown }> = []
    ctx.on('loader/entry-failed', (options, error) => {
      failedEvents.push({ id: options.id, name: options.name, error })
    })

    try {
      // Apply the entries via root group
      await ctx.loader.root.update([
        { id: 'h1', name: './healthy1.mjs' },
        { id: 'bad', name: './broken.mjs' },
        { id: 'h2', name: './healthy2.mjs' },
      ])

      // Must not throw, and failed event must be captured
      expect(failedEvents.length).toBe(1)
      expect(failedEvents[0]?.id).toBe('bad')
      expect(String(failedEvents[0]?.error)).toContain('Broken third-party plugin crashed')

      // Healthy entries must be active with zero rollback
      expect(ctx.get('service1')).toEqual({ active: true })
      expect(ctx.get('service2')).toEqual({ active: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loud and rolls back in default strict mode (backward compatibility)', async () => {
    const dir = createTempDir()
    const baseUrl = pathToFileURL(dir).href + '/'

    writeFileSync(join(dir, 'healthy1.mjs'), [
      'export const name = "healthy1"',
      'export function apply(ctx) {',
      '  ctx.provide("service1", { active: true })',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'broken.mjs'), [
      'export const name = "broken"',
      'export function apply() {',
      '  throw new Error("Fatal crash in strict mode")',
      '}',
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = baseUrl
    await ctx.plugin(Loader, { baseUrl }) // default: tolerateEntryFailures is false

    try {
      await expect(
        ctx.loader.root.update([
          { id: 'h1', name: './healthy1.mjs' },
          { id: 'bad', name: './broken.mjs' },
        ]),
      ).rejects.toThrow(/Fatal crash in strict mode/)

      // Healthy service must have been rolled back
      expect(ctx.get('service1')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('supports predicate filter to distinguish essential vs optional entries', async () => {
    const dir = createTempDir()
    const baseUrl = pathToFileURL(dir).href + '/'

    writeFileSync(join(dir, 'optional-broken.mjs'), [
      'export const name = "optional-broken"',
      'export function apply() {',
      '  throw new Error("Optional plugin failed")',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'essential-broken.mjs'), [
      'export const name = "essential-broken"',
      'export function apply() {',
      '  throw new Error("Critical service failed")',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'healthy.mjs'), [
      'export const name = "healthy"',
      'export function apply(ctx) {',
      '  ctx.provide("coreService", { ok: true })',
      '}',
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = baseUrl
    await ctx.plugin(Loader, {
      baseUrl,
      tolerateEntryFailures: options => options.id !== 'critical',
    })

    try {
      // 1. When optional fails, tolerated
      await ctx.loader.root.update([
        { id: 'core', name: './healthy.mjs' },
        { id: 'opt', name: './optional-broken.mjs' },
      ])
      expect(ctx.get('coreService')).toEqual({ ok: true })

      // 2. When essential fails, throws
      await expect(
        ctx.loader.root.update([
          { id: 'critical', name: './essential-broken.mjs' },
        ]),
      ).rejects.toThrow(/Critical service failed/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes tolerateEntryFailures through Include plugin to nested subtrees', async () => {
    const dir = createTempDir()
    const baseUrl = pathToFileURL(dir).href + '/'

    writeFileSync(join(dir, 'plugin.mjs'), [
      'export const name = "plugin"',
      'export function apply(ctx) {',
      '  ctx.provide("treeService", { ok: true })',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'bad.mjs'), [
      'export const name = "bad"',
      'export function apply() {',
      '  throw new Error("Subtree plugin failed")',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'subtree.json'), JSON.stringify([
      { id: 'p1', name: './plugin.mjs' },
      { id: 'bad', name: './bad.mjs' },
    ]))

    const ctx = new Context()
    ctx.baseUrl = baseUrl
    await ctx.plugin(Loader, { baseUrl })

    const failed = vi.fn()
    ctx.on('loader/entry-failed', failed)

    try {
      await ctx.plugin(Include, {
        path: './subtree.json',
        tolerateEntryFailures: true,
      })

      expect(failed).toHaveBeenCalledOnce()
      expect(ctx.get('treeService')).toEqual({ ok: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
