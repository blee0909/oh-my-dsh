import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boot, type BootOptions } from '../src/index.ts'

const NAME = 'dsh-quarantine-spec'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-quarantine-'))

describe('Plugin Quarantine & Safe Mode (#5426)', () => {
  it('quarantines a plugin that throws during activation in safe-mode and boots successfully', async () => {
    const dir = tmp()
    // Plugin A is broken and throws in apply()
    writeFileSync(join(dir, 'broken.mjs'), [
      'export const name = "broken"',
      'export function apply() {',
      '  throw new Error("Broken community plugin syntax or runtime error")',
      '}',
      '',
    ].join('\n'))

    // Plugin B is a healthy plugin
    writeFileSync(join(dir, 'healthy.mjs'), [
      'export const name = "healthy"',
      'export function apply(ctx) {',
      '  ctx.provide("healthyService", { ok: true })',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: broken',
      '  name: ./broken.mjs',
      '- id: healthy',
      '  name: ./healthy.mjs',
      '',
    ].join('\n'))

    const options: BootOptions = {
      faultTolerance: 'safe-mode',
    }

    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, undefined, undefined, options)
    try {
      const quarantine = ctx.get('quarantine')
      expect(quarantine).toBeDefined()
      expect(quarantine?.isSafeMode).toBe(true)
      expect(quarantine?.entries.length).toBe(1)
      expect(quarantine?.entries[0]?.id).toBe('broken')
      expect(quarantine?.entries[0]?.stage).toBe('activation')
      expect(String(quarantine?.entries[0]?.error)).toContain('Broken community plugin')

      // Healthy plugin must be alive and functional
      expect(ctx.get('healthyService')).toEqual({ ok: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loud in default strict mode when the same broken plugin is encountered', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'broken.mjs'), [
      'export const name = "broken"',
      'export function apply() {',
      '  throw new Error("Fatal in strict mode")',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: broken',
      '  name: ./broken.mjs',
      '',
    ].join('\n'))

    // Default boot (without safe-mode option) must throw!
    await expect(boot(NAME, join(dir, 'cordis.yml'))).rejects.toThrow(/broken.*Fatal in strict mode/)
  })

  it('fails loud even in safe-mode when a declared essential entry fails', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'critical-gateway.mjs'), [
      'export const name = "critical-gateway"',
      'export function apply() {',
      '  throw new Error("API Gateway crashed")',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: critical-gateway',
      '  name: ./critical-gateway.mjs',
      '',
    ].join('\n'))

    const options: BootOptions = {
      faultTolerance: 'safe-mode',
      essentialEntries: ['critical-gateway'],
    }

    // Essential entry must NEVER be quarantined; it must fail loud!
    await expect(boot(NAME, join(dir, 'cordis.yml'), undefined, undefined, undefined, options)).rejects.toThrow(
      /critical-gateway.*API Gateway crashed/,
    )
  })

  it('performs cascading pruning on entries pending on services from quarantined plugins', async () => {
    const dir = tmp()
    // Plugin A (broken provider)
    writeFileSync(join(dir, 'broken-provider.mjs'), [
      'export const name = "broken-provider"',
      'export function apply() {',
      '  throw new Error("Provider initialization failed")',
      '}',
      '',
    ].join('\n'))

    // Plugin B (consumer waiting for missingService)
    writeFileSync(join(dir, 'consumer.mjs'), [
      'export const name = "consumer"',
      'export const inject = ["missingService"]',
      'export function apply(ctx) {',
      '  ctx.provide("consumerService", true)',
      '}',
      '',
    ].join('\n'))

    // Plugin C (independent healthy plugin)
    writeFileSync(join(dir, 'independent.mjs'), [
      'export const name = "independent"',
      'export function apply(ctx) {',
      '  ctx.provide("independentService", { status: "active" })',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: broken-provider',
      '  name: ./broken-provider.mjs',
      '- id: consumer',
      '  name: ./consumer.mjs',
      '- id: independent',
      '  name: ./independent.mjs',
      '',
    ].join('\n'))

    const options: BootOptions = {
      faultTolerance: 'safe-mode',
    }

    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, undefined, undefined, options)
    try {
      const quarantine = ctx.get('quarantine')
      expect(quarantine).toBeDefined()
      expect(quarantine?.isSafeMode).toBe(true)

      // Both broken-provider and its dependent consumer should be quarantined
      expect(quarantine?.has('broken-provider')).toBe(true)
      expect(quarantine?.has('consumer')).toBe(true)

      const consumerRecord = quarantine?.entries.find(e => e.id === 'consumer')
      expect(consumerRecord?.stage).toBe('cascading')
      expect(consumerRecord?.missingServices).toContain('missingService')

      // Independent service must NOT be affected
      expect(ctx.get('independentService')).toEqual({ status: 'active' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('formats a clean human-readable diagnostic report for quarantined plugins', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'faulty.mjs'), [
      'export const name = "faulty"',
      'export function apply() {',
      '  throw new Error("Community extension bug")',
      '}',
      '',
    ].join('\n'))

    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: faulty',
      '  name: ./faulty.mjs',
      '',
    ].join('\n'))

    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, undefined, undefined, {
      faultTolerance: 'safe-mode',
    })
    try {
      const quarantine = ctx.get('quarantine')
      expect(quarantine).toBeDefined()
      const summary = quarantine!.formatSummary()
      expect(summary).toContain('Safe Mode')
      expect(summary).toContain('faulty')
      expect(summary).toContain('Community extension bug')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
