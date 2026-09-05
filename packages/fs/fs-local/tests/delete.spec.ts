import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '../src/index.ts'

describe('LocalFileSystem delete primitive with sandbox policy (#5461)', () => {
  let tempDir: string
  let fs: LocalFileSystem

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-fs-local-delete-'))
    const ctx = new Context()
    fs = new LocalFileSystem(ctx, { cwd: tempDir, diffBasisMaxBytes: 1024 * 1024 })
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('deletes an individual file from disk', async () => {
    const filePath = join(tempDir, 'sample.txt')
    writeFileSync(filePath, 'hello delete', 'utf8')
    expect(existsSync(filePath)).toBe(true)

    const target = await fs.resolve(filePath)
    const outcome = await fs.delete(target)

    expect(outcome.success).toBe(true)
    expect(existsSync(filePath)).toBe(false)
  })

  it('deletes directories recursively when recursive flag is set', async () => {
    const subDir = join(tempDir, 'subfolder')
    mkdirSync(subDir)
    writeFileSync(join(subDir, 'nested.txt'), 'nested', 'utf8')

    const target = await fs.resolve(subDir)
    const outcome = await fs.delete(target, { recursive: true })

    expect(outcome.success).toBe(true)
    expect(existsSync(subDir)).toBe(false)
  })

  it('fences out-of-workspace and non-temp delete attempts under workspace-write policy', async () => {
    // A path outside both workspaceRoot and system tmpdir (e.g. sibling outside directory)
    const outsideDir = mkdtempSync(join(tmpdir(), '..', 'dsh-other-tree-'))
    const outsideFile = join(outsideDir, 'dangerous.txt')
    writeFileSync(outsideFile, 'dangerous', 'utf8')

    const target = await fs.resolve(outsideFile)

    await expect(
      fs.delete(target, undefined, undefined, { mode: 'workspace-write', workspaceRoot: tempDir }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))

    // Ensure the outside file was NOT touched
    expect(existsSync(outsideFile)).toBe(true)
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('allows deleting legitimate temporary files in system tmpdir under workspace-write mode', async () => {
    const tempFile = join(tmpdir(), `legit-temp-${Date.now()}.txt`)
    writeFileSync(tempFile, 'temporary data', 'utf8')
    expect(existsSync(tempFile)).toBe(true)

    const target = await fs.resolve(tempFile)
    const outcome = await fs.delete(target, undefined, undefined, { mode: 'workspace-write', workspaceRoot: tempDir })

    expect(outcome.success).toBe(true)
    expect(existsSync(tempFile)).toBe(false)
  })

  it('strictly blocks prefix-spoofing paths outside workspace', async () => {
    const customWorkspace = join(process.cwd(), 'temp-test-ws')
    const customEvilDir = join(process.cwd(), 'temp-test-ws-evil')
    mkdirSync(customEvilDir, { recursive: true })
    const evilFile = join(customEvilDir, 'victim.txt')
    writeFileSync(evilFile, 'protect me', 'utf8')

    const target = await fs.resolve(evilFile)

    await expect(
      fs.delete(target, undefined, undefined, { mode: 'workspace-write', workspaceRoot: customWorkspace }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))

    expect(existsSync(evilFile)).toBe(true)
    rmSync(customEvilDir, { recursive: true, force: true })
  })
})
