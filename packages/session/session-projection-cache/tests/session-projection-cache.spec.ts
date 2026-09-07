import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, {
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '../src/index.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'lru-test/marks': MarksState
  }
  interface SessionProjectionMap {
    'lru-test/marks': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'lru-test/mark': { marks: string[] }
  }
  interface OutOfBandSessionEventMap {
    'lru-test/mark': true
  }
}

type MarksState = { marks: string[] } | null
const marksUnit = () => ({
  key: 'lru-test/marks',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'lru-test/mark' ? (event).data : state),
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'lru-test/marks', MarksState>

describe('SessionProjectionCache LRU eviction & Memory Management (#5772)', () => {
  const roots: string[] = []

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop()!
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  async function harness(maxCachedSessions: number) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-lru-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(marksUnit())
    await ctx.plugin(SessionProjectionCache, {
      writeEveryEvents: 100,
      writeIntervalMs: 60_000,
      maxCachedSessions,
    })
    return { ctx, cache: ctx.sessionProjectionCache }
  }

  it('evicts oldest sessions when maxCachedSessions limit is exceeded', async () => {
    const { ctx, cache } = await harness(2)

    // Create 3 sessions
    const s1 = ctx.sessions.create()
    s1.append('lru-test/mark', { marks: ['session-1'] })
    await cache.write(s1)

    const s2 = ctx.sessions.create()
    s2.append('lru-test/mark', { marks: ['session-2'] })
    await cache.write(s2)

    // Both s1 and s2 should be cached
    expect(cache.cachedSnapshot(s1.header, SessionLogOffset(0))).toBeDefined()
    expect(cache.cachedSnapshot(s2.header, SessionLogOffset(0))).toBeDefined()

    // Create s3, exceeding maxCachedSessions = 2
    const s3 = ctx.sessions.create()
    s3.append('lru-test/mark', { marks: ['session-3'] })
    await cache.write(s3)

    // s1 was the oldest, so it should be evicted from in-memory cache
    expect(cache.cachedSnapshot(s1.header, SessionLogOffset(0))).toBeUndefined()
    expect(cache.cachedSnapshot(s2.header, SessionLogOffset(0))).toBeDefined()
    expect(cache.cachedSnapshot(s3.header, SessionLogOffset(0))).toBeDefined()

    // The underlying table records map should also have had s1 removed
    const internalCache = cache as unknown as { table?: { records?: Map<string, unknown> } }
    const records = internalCache.table?.records
    expect(records?.has(s1.id)).toBe(false)
    expect(records?.has(s2.id)).toBe(true)
    expect(records?.has(s3.id)).toBe(true)
  })

  it('restores evicted session seamlessly on coldSnapshot and refreshes cache', async () => {
    const { ctx, cache } = await harness(2)

    const s1 = ctx.sessions.create()
    s1.append('lru-test/mark', { marks: ['session-1'] })
    await cache.write(s1)

    const s2 = ctx.sessions.create()
    s2.append('lru-test/mark', { marks: ['session-2'] })
    await cache.write(s2)

    const s3 = ctx.sessions.create()
    s3.append('lru-test/mark', { marks: ['session-3'] })
    await cache.write(s3)

    // s1 was evicted
    expect(cache.cachedSnapshot(s1.header, SessionLogOffset(0))).toBeUndefined()

    // Perform coldSnapshot on s1
    const coldSnapshot = cache.coldSnapshot(
      s1.header,
      SessionLogOffset(0),
      s1.snapshotEvents(),
    )
    expect(coldSnapshot.values['lru-test/marks']).toEqual({ marks: ['session-1'] })

    // s1 is refreshed back into cache asynchronously, and s2 (now oldest) is evicted
    await vi.waitFor(() => {
      expect(cache.cachedSnapshot(s1.header, SessionLogOffset(0))).toBeDefined()
      expect(cache.cachedSnapshot(s2.header, SessionLogOffset(0))).toBeUndefined()
      expect(cache.cachedSnapshot(s3.header, SessionLogOffset(0))).toBeDefined()
    }, { timeout: 5_000 })
  })
})
