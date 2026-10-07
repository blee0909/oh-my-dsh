/** Regression expectations for an external editor save during a guarded mutation. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '../src/index.ts'

const run = promisify(execFile)
it.each(['write', 'edit'] as const)('%s preserves a newer external save made during staging', async (operation) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lost-save-'))
  const path = join(dir, 'document.txt')
  const original = 'title=original\nbody=original user content\n'
  const external = 'title=original\nbody=NEW USER CONTENT - must survive\n'
  const agent = 'title=agent\nbody=original user content\n'
  const ctx = new Context()
  try {
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    const fs = ctx.fs as LocalFileSystem
    await writeFile(path, original)
    const target = await fs.resolve(path)
    expect(await fs.readText(target)).toBe(original)
    const observed = await fs.stat(target)
    if (observed === undefined) throw new Error('fixture not created')
    let externalSaveVerified = false
    let externalVersion: string | undefined
    fs.internals.inspectTemp = async () => {
      await run(process.execPath, [
        '-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', path, external,
      ])
      externalSaveVerified = (await readFile(path, 'utf8')) === external
      externalVersion = (await fs.stat(target))?.version
    }
    let failure: unknown
    try {
      if (operation === 'write') {
        await fs.writeText(target, agent, { kind: 'replaceIfVersion', version: observed.version })
      } else {
        await fs.editText(target, { oldString: 'title=original', newString: 'title=agent', replaceAll: false }, { version: observed.version })
      }
    } catch (error) { failure = error }
    const stored = await readFile(path, 'utf8')
    const evidence = {
      operation, platform: process.platform, original, external, agent, stored,
      externalSaveVerified, versionChanged: externalVersion !== observed.version,
      mutationReportedSuccess: failure === undefined,
      externalContentLost: stored !== external && !stored.includes('NEW USER CONTENT'),
    }
    console.log(JSON.stringify(evidence))
    expect(externalSaveVerified).toBe(true)
    expect(externalVersion).not.toBe(observed.version)
    expect(stored).toBe(external)
    expect(failure).toMatchObject({ code: 'FS_STALE_VERSION' })
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
