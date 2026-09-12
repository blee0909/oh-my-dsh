/**
 * DeepSeek `fetch` that recycles the process HTTP dispatcher after a dead pool.
 *
 * Node `fetch` keeps HTTP/2 sessions in whatever undici dispatcher is installed —
 * the default Agent, or the one `@deepseek-ai/dsh-http-proxy` mounted. After the
 * process loses a local address, pooled sockets stay `CLOSED` and every retry
 * reuses them. A non-abort rejection asks the proxy package to replace that
 * dispatcher with the same policy so `llm-retry` opens a new session.
 *
 * Callers must not pass a private `dispatcher`: that would bypass the process
 * proxy policy.
 *
 * @module dsh-llm-deepseek/transport
 */

import { recycleGlobalDispatcher } from '@deepseek-ai/dsh-http-proxy'

/**
 * `fetch` through the process dispatcher. A rejection that is not a caller abort
 * recycles that dispatcher before the error is rethrown.
 *
 * @param input - request URL or Request.
 * @param init - standard fetch init; `signal.aborted` skips the recycle.
 */
export async function deepSeekFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await globalThis.fetch(input, init)
  } catch (error: unknown) {
    if (init?.signal?.aborted !== true) await recycleGlobalDispatcher()
    throw error
  }
}
