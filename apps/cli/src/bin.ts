#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync, realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

/**
 * Check whether the current ESM module is the main process entrypoint.
 * Compatible with Node.js 24+ (`import.meta.main`), Node.js < 24 (`process.argv[1]`
 * match with optional symlink resolution), and alternative runtimes (Deno, Bun).
 * @param metaUrl - The `import.meta.url` of the module being tested.
 * @param entry - The entry file path, defaults to `process.argv[1]`.
 */
export function isMainModule(metaUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (import.meta.main) return true
  if (!entry) return false
  try {
    const current = resolvePath(fileURLToPath(metaUrl))
    const resolvedEntry = resolvePath(entry)
    if (current === resolvedEntry) return true
    try {
      return realpathSync(current) === realpathSync(resolvedEntry)
    } catch {
      return false
    }
  } catch {
    return false
  }
}

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/**
 * Run the public dsh command-line interface.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(): Promise<void> {
  const invocation = parseDshArgs(process.argv.slice(2), readVersion())

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile: invocation.profile,
        fromDefaultProfile: invocation.fromDefaultProfile,
        patchFiles: invocation.patches,
        args: invocation.args,
      })
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(runPlugin(invocation.profile, invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (isMainModule(import.meta.url)) {
  await runCli()
}
