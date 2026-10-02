import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installRuntimeInterception, type RuntimeInterception } from '../src/profile-resolution/resolver.ts'
import { createRuntimeResolution, type Profile } from '../src/profile.ts'

const roots: string[] = []
const registrations: RuntimeInterception[] = []

afterEach(() => {
  for (const registration of registrations.splice(0).reverse()) registration.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function fixture(): {
  root: string
  installAnchor: string
  profile: Profile
} {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-profile-res-process-')))
  roots.push(root)
  const installDir = join(root, 'global', 'node_modules', '@deepseek-ai', 'dsh')
  file(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
  const profileDir = join(root, 'profiles', 'web')
  file(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'process': '*' },
  }))
  return {
    root,
    installAnchor: join(installDir, 'package.json'),
    profile: {
      skippedBundles: [],
      name: 'web',
      dir: profileDir,
      layers: [],
      patchPath: join(profileDir, 'cordis.patch.yml'),
      patches: [],
    },
  }
}

describe('Discussions #8674: require("process/") resolution with installed process package', () => {
  it('resolves require("process/") to installed node_modules/process under runtime interception', async () => {
    const f = fixture()
    const pkgDir = join(f.profile.dir, 'node_modules', 'process')
    file(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'process',
      version: '0.11.10',
      main: 'index.js',
    }))
    file(join(pkgDir, 'index.js'), 'module.exports = { isMockProcess: true };\n')

    const entryFile = join(f.profile.dir, 'entry.cjs')
    file(entryFile, 'module.exports = {};\n')

    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)

    const require = createRequire(entryFile)

    // Under runtime interception:
    // Native Node: require.resolve('process/') resolves to the package index.js
    // Intercepted Node: must NOT crash and MUST resolve to process/index.js!
    const resolved = require.resolve('process/')
    expect(resolved).toContain('process')
    const mod = require('process/')
    expect(mod.isMockProcess).toBe(true)
  })
})
