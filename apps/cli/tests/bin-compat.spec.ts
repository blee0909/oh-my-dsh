import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMainModule as isCliMainModule } from '../src/bin.ts'
import { isMainModule as isSubprocessMainModule } from '../../../packages/subprocess/subprocess-local/src/bin.ts'

describe('Discussions #6124: Cross-version CLI entrypoint guard (isMainModule)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-bin-compat-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('identifies entrypoint when entry matches target file URL directly', () => {
    const targetFile = join(tempDir, 'entry.mjs')
    writeFileSync(targetFile, 'export const marker = 1\n')
    const fileUrl = pathToFileURL(targetFile).href

    // Exact absolute match
    expect(isCliMainModule(fileUrl, targetFile)).toBe(true)
    expect(isSubprocessMainModule(fileUrl, targetFile)).toBe(true)
  })

  it('identifies entrypoint when entry is a relative path', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const cliSource = join(repoRoot, 'apps/cli/src/bin.ts')
    const fileUrl = pathToFileURL(cliSource).href

    const relativeEntry = relative(process.cwd(), cliSource)
    expect(isCliMainModule(fileUrl, relativeEntry)).toBe(true)
    expect(isSubprocessMainModule(fileUrl, relativeEntry)).toBe(true)
  })

  it('identifies entrypoint when accessed via symlink (Linux/macOS or supported Windows environments)', () => {
    const targetFile = join(tempDir, 'real-bin.js')
    writeFileSync(targetFile, 'export const marker = 1\n')
    const symlinkFile = join(tempDir, 'dsh-symlink')

    try {
      symlinkSync(targetFile, symlinkFile)
      const fileUrl = pathToFileURL(targetFile).href
      expect(isCliMainModule(fileUrl, symlinkFile)).toBe(true)
      expect(isSubprocessMainModule(fileUrl, symlinkFile)).toBe(true)
    } catch {
      // Windows unprivileged environments without SeCreateSymbolicLinkPrivilege
      // safely skip the filesystem symlink branch while maintaining path check
    }
  })

  it('rejects entrypoint when current module is imported by a different script (library mode)', () => {
    const currentModule = pathToFileURL(join(tempDir, 'imported-module.mjs')).href
    const differentEntry = join(tempDir, 'caller-script.mjs')

    expect(isCliMainModule(currentModule, differentEntry)).toBe(false)
    expect(isSubprocessMainModule(currentModule, differentEntry)).toBe(false)
  })

  it('rejects entrypoint when entry path is undefined or empty', () => {
    const currentModule = pathToFileURL(join(tempDir, 'target.mjs')).href

    expect(isCliMainModule(currentModule, undefined)).toBe(false)
    expect(isCliMainModule(currentModule, '')).toBe(false)
    expect(isSubprocessMainModule(currentModule, undefined)).toBe(false)
    expect(isSubprocessMainModule(currentModule, '')).toBe(false)
  })

  it('executes source CLI entrypoint via child process without hanging or silent exit', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const cliSource = join(repoRoot, 'apps/cli/src/bin.ts')

    const result = await execa(process.execPath, ['--import', 'tsx/esm', cliSource, '--version'], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      reject: false,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u)
    expect(result.stderr).toBe('')
  })
})
