/**
 * Plugin Quarantine and Safe Mode registry for Cordis loader fault tolerance.
 * Isolates failing third-party or optional plugins so that the core host can
 * boot in Safe Mode and provide self-repair capability.
 * @module @deepseek-ai/dsh-app-boot/quarantine
 */

import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Global plugin quarantine service when booted in safe-mode. */
    quarantine?: PluginQuarantine
  }
}

/** Record of an isolated plugin that failed during import or activation. */
export interface QuarantinedPlugin {
  /** Loader entry ID. */
  readonly id: string
  /** Plugin module name / specifier. */
  readonly name: string
  /** The underlying error or rejection reason. */
  readonly error: unknown
  /** Stage where failure occurred: import, activation, or cascading dependency. */
  readonly stage: 'import' | 'activation' | 'cascading'
  /** Services that were missing when cascading quarantine was triggered. */
  readonly missingServices?: readonly string[]
  /** Timestamp when the entry was quarantined. */
  readonly quarantinedAt: number
}

/** Service interface for inspecting and managing quarantined plugins. */
export interface PluginQuarantine {
  /** Readonly list of all quarantined plugins. */
  readonly entries: readonly QuarantinedPlugin[]
  /** Whether the host is currently in Safe Mode (has 1 or more quarantined plugins). */
  readonly isSafeMode: boolean
  /** Check if a specific entry ID is in quarantine. */
  has(id: string): boolean
  /** Record a failed entry into quarantine. */
  record(entry: QuarantinedPlugin): void
  /** Release an entry from quarantine (e.g. after HMR repair). */
  release(id: string): boolean
  /** Format a human-readable diagnostic banner. */
  formatSummary(): string
}

/** Create a new in-memory plugin quarantine registry. */
export function createPluginQuarantine(): PluginQuarantine {
  const records = new Map<string, QuarantinedPlugin>()

  return {
    get entries(): readonly QuarantinedPlugin[] {
      return [...records.values()]
    },
    get isSafeMode(): boolean {
      return records.size > 0
    },
    has(id: string): boolean {
      return records.has(id)
    },
    record(entry: QuarantinedPlugin): void {
      records.set(entry.id, entry)
    },
    release(id: string): boolean {
      return records.delete(id)
    },
    formatSummary(): string {
      if (records.size === 0) {
        return 'Safe Mode: inactive (no plugins quarantined)'
      }
      const lines: string[] = [
        '┌─────────────────────────────────────────────────────────────┐',
        `│ ⚠️  DSH Safe Mode: ${records.size} plugin(s) quarantined                │`,
        '├─────────────────────────────────────────────────────────────┤',
      ]
      for (const entry of records.values()) {
        const errStr = entry.error instanceof Error ? entry.error.message : String(entry.error)
        const truncated = errStr.length > 50 ? `${errStr.slice(0, 47)}...` : errStr
        lines.push(`│ • [${entry.stage}] ${entry.id}: ${truncated}`)
        if (entry.missingServices && entry.missingServices.length > 0) {
          lines.push(`│   Missing dependencies: ${entry.missingServices.join(', ')}`)
        }
      }
      lines.push('└─────────────────────────────────────────────────────────────┘')
      return lines.join('\n')
    },
  }
}
