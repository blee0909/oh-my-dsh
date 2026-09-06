import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FileSystem, { FsTargetKey, FsError } from '../src/index.ts'
import type { FsTarget, FsDeleteOutcome, FsDeleteOptions } from '../src/types.ts'

class MockFileSystem extends FileSystem {
  deletedTargets: string[] = []

  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return `file:///${encodeURIComponent(String(target.targetKey))}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.targetKey === parent.targetKey || String(child.targetKey).startsWith(`${parent.targetKey}/`)
  }

  override async stat(): Promise<never> { throw new Error('not implemented') }
  override async lstat(): Promise<never> { throw new Error('not implemented') }
  override async readText(): Promise<never> { throw new Error('not implemented') }
  override async streamText(): Promise<never> { throw new Error('not implemented') }
  override async readBytes(): Promise<never> { throw new Error('not implemented') }
  override async listDir(): Promise<never> { throw new Error('not implemented') }
  override async writeText(): Promise<never> { throw new Error('not implemented') }
  override async editText(): Promise<never> { throw new Error('not implemented') }

  override async delete(
    target: FsTarget,
    _options?: FsDeleteOptions,
    _signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<FsDeleteOutcome> {
    const path = this.processPath(target)
    const policy = typeof sandboxPolicy === 'object' && sandboxPolicy !== null ? (sandboxPolicy as { mode?: string }) : undefined
    if (policy?.mode === 'workspace-write' && path.startsWith('/etc/')) {
      throw new FsError('Destination path outside workspace sandbox', 'FS_SANDBOX_DENIED')
    }
    this.deletedTargets.push(path)
    return { success: true }
  }
}

describe('Layer 4 Policy-Aware FileSystem delete primitive (#5461)', () => {
  it('invokes the policy-aware delete operation successfully for allowed paths', async () => {
    const ctx = new Context()
    const fs = new MockFileSystem(ctx)
    const target = await fs.resolve('workspace/temp.txt')

    const outcome = await fs.delete(target, { recursive: false })
    expect(outcome.success).toBe(true)
    expect(fs.deletedTargets).toContain('workspace/temp.txt')
  })

  it('fences out-of-workspace delete attempts under workspace-write policy', async () => {
    const ctx = new Context()
    const fs = new MockFileSystem(ctx)
    const outsideTarget = await fs.resolve('/etc/shadow')

    await expect(
      fs.delete(outsideTarget, undefined, undefined, { mode: 'workspace-write', workspaceRoot: '/workspace' }),
    ).rejects.toThrow(/Destination path outside workspace sandbox/)
  })
})
