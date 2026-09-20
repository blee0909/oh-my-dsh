import { describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

function globToRegex(glob: string): RegExp {
  const str = glob
    .replace(/\./g, '\\.')
    .replace(/\{([^}]+)\}/g, (_, p) => '(' + p.split(',').join('|') + ')')
    .replace(/\*\*\//g, '__GLOBSTAR_SLASH__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GLOBSTAR_SLASH__/g, '(?:.*/)?')
    .replace(/__GLOBSTAR__/g, '.*')
  return new RegExp('^' + str + '$')
}

describe('electron-builder packaging configuration', () => {
  it('includes ripgrep platform package unpack wildcard covering all targets', () => {
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.desktop',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
      DSH_DESKTOP_TARGET_ARCH: 'arm64',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_API_KEY: '/private/credentials/AuthKey_TEST123456.p8',
      APPLE_API_KEY_ID: 'TEST123456',
      APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    })

    expect(config.asarUnpack).toContain('**/@vscode/ripgrep/bin/rg')
    expect(config.asarUnpack).toContain('**/@vscode/ripgrep*/bin/rg*')

    const platformBinaries = [
      'dsh/node_modules/@vscode/ripgrep/bin/rg',
      'dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
      'dsh/node_modules/@vscode/ripgrep-darwin-x64/bin/rg',
      'dsh/node_modules/@vscode/ripgrep-linux-x64/bin/rg',
      'dsh/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
    ]

    for (const binPath of platformBinaries) {
      const matched = config.asarUnpack.some((rule: string) => globToRegex(rule).test(binPath))
      expect(matched, `Expected ${binPath} to be matched by asarUnpack`).toBe(true)
    }
  })
})
