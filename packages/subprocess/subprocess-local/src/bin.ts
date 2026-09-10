/** Thin executable/importable entry for the provider-private runner core. */

import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consumeRunnerSelection } from './runner-launch.ts'
import { reportSpawnRunnerFailure, runSpawnRunner } from './spawn-runner.ts'

/**
 * Check whether the current ESM module is the main process entrypoint.
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

/**
 * Run a selector already removed by a packaging bootstrap.
 * @param selection - private runner selector or Linux launch-request locator.
 */
export async function runSelectedSubprocessRunner(selection: string): Promise<void> {
  try {
    await runSpawnRunner(selection, process.argv.slice(2))
  } catch (error) {
    await reportSpawnRunnerFailure(selection, error)
  }
}

if (isMainModule(import.meta.url)) {
  const selection = consumeRunnerSelection()
  if (selection === undefined) {
    process.exitCode = 127
  } else {
    void runSelectedSubprocessRunner(selection)
  }
}
