/** Chat-owned approval detail resolving a correlated Tool call's command. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '../contract/chat-nodes.ts'

interface ApprovalToolCall {
  readonly callId?: string
  readonly argsRaw?: string
}

/**
 * Extract a shell command from a correlated Tool call when its arguments carry one.
 * Compatible with aliases: command, commandLine, cmd, script.
 * @param call - Tool call arguments, when a correlated call exists.
 * @returns command text, or undefined for absent, malformed, or unrelated arguments.
 */
export function commandOf(call: ApprovalToolCall | undefined): string | undefined {
  if (call === undefined || typeof call.argsRaw !== 'string') return undefined
  try {
    const args = JSON.parse(call.argsRaw) as Record<string, unknown>
    if (typeof args.command === 'string' && args.command.trim().length > 0) return args.command
    if (typeof args.commandLine === 'string' && args.commandLine.trim().length > 0) return args.commandLine
    if (typeof args.cmd === 'string' && args.cmd.trim().length > 0) return args.cmd
    if (typeof args.script === 'string' && args.script.trim().length > 0) return args.script
    return undefined
  } catch {
    return undefined
  }
}

interface InterruptedError {
  code?: unknown
}

interface BlockLike {
  argsRaw?: unknown
  call?: {
    callId?: unknown
    argsRaw?: unknown
  }
  callId?: unknown
  error?: InterruptedError
  interrupted?: unknown
  status?: unknown
  kind?: unknown
  subCalls?: unknown[]
}

function extractArgsRaw(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined
  const b = block as BlockLike
  if (typeof b.argsRaw === 'string') {
    return b.argsRaw
  }
  if (b.call && typeof b.call === 'object' && typeof b.call.argsRaw === 'string') {
    return b.call.argsRaw
  }
  return undefined
}

/**
 * Render the command of the Chat Tool node correlated with an approval.
 * @param props - Approval identity and Session-standard Chat selector hook.
 * @returns command text when the correlated call carries one.
 */
export function ApprovalCommand({ callId, useChat }: PropsRuntime<'conversation.approval.detail'>) {
  const command = useChat((snapshot) => {
    const scanBlock = (block: unknown): string | undefined => {
      if (!block || typeof block !== 'object') return undefined
      const b = block as BlockLike
      const isInterrupted = b.error?.code === 'interrupted' || b.interrupted === true || b.status === 'interrupted'
      const isPendingOrInterrupted = !('kind' in b) || isInterrupted
      if (isPendingOrInterrupted && (b.callId === callId || b.call?.callId === callId)) {
        const raw = extractArgsRaw(b)
        if (raw) {
          const cmd = commandOf({ argsRaw: raw })
          if (cmd) return cmd
        }
      }
      if (Array.isArray(b.subCalls)) {
        for (const sub of b.subCalls) {
          const found = scanBlock(sub)
          if (found) return found
        }
      }
      return undefined
    }

    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (root !== undefined) {
        const found = scanBlock(root)
        if (found) return found
      }
    }
    return undefined
  })
  return command ?? null
}
