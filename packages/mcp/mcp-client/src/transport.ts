/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * Expand shell-style variable references (${VAR} and $VAR) against the harness
 * process environment (Discussions #6075). Unset variables expand to empty string.
 */
export function expandEnvValue(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof value !== 'string') return String(value ?? '')
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
    const key = braced ?? bare
    return env[key] ?? ''
  })
}

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env with `${VAR}` and `$VAR`
 * placeholders expanded against `process.env` (Discussions #6075). The MCP SDK
 * owns the actual spawn, so this transport shares the scrub definition rather
 * than the spawn path.
 */
export function buildChildEnv(
  extra: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const expandedExtra: Record<string, string> = {}
  for (const [key, value] of Object.entries(extra)) {
    expandedExtra[key] = expandEnvValue(value, env)
  }
  return { ...scrubbedParentEnv(), ...expandedExtra }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      // The MCP SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening.
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } },
      ) as Transport
  }
}
