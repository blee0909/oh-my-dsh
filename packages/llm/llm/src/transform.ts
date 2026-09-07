/**
 * Outbound Message Transformation Pipeline.
 *
 * Implements defensive normalization inspired by Pi-Agent's Layer 1 architecture:
 * 1. Sanitizes empty assistant content (#5466) by promoting reasoning text or fallback placeholder.
 * 2. Auto-heals isolated tool-calls (#5445) by synthesizing missing tool-results.
 * 3. Enforces strict Turn Alternation Coalescing: merges adjacent same-role messages
 *    (preventing Anthropic/Bedrock/Gemini HTTP 400 "roles must alternate" errors).
 * 4. In-history system messages (occurring after conversation starts) are safely converted
 *    to user directives to satisfy strict API gateway parameters.
 * 5. Safely downgrades reverse-orphan tool-results (tool-result without preceding tool-call)
 *    into clean text representations to prevent tool-call-id mismatch errors.
 * 6. Implements Bounded Budget Tool Output Truncation (64,000 chars) with Head/Tail preservation.
 * 7. Preserves reference invariance when messages require no modification.
 *
 * @module @deepseek-ai/dsh-llm/transform
 */

import type { ContentBlock, Message } from './types.ts'
import type { ToolCallId } from './brand.ts'
import { createToolResultMessage, createUserMessage, freezeMessage } from './message.ts'

export interface TransformOptions {
  /** Optional target model capabilities or vendor identifier */
  targetVendor?: string
  /** Whether to strip terminal error/aborted assistant turns */
  stripTerminalErrors?: boolean
}

export const FALLBACK_EMPTY_ASSISTANT_TEXT = '(thinking completed without explicit text)'
export const SYNTHETIC_TOOL_RESULT_TEXT = 'Execution interrupted: no tool result provided'

/** Absolute safe budget ceiling for a single tool output (characters) */
export const MAX_TOOL_OUTPUT_CHARS = 64_000
/** Head characters retained when truncation occurs (20% of 64k budget) */
export const HEAD_CHARS = 12_800
/** Tail characters retained when truncation occurs (20% of 64k budget) */
export const TAIL_CHARS = 12_800

/** Extract text content recursively from a sequence of content blocks. */
function extractTextFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text
      if (b.type === 'tool-result') return extractTextFromBlocks(b.content)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Truncate text block within bounded budget preserving head and tail. */
function truncateTextUnderBudget(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text
  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(-TAIL_CHARS)
  const notice = `\n... [DSH System Guard: Tool output truncated (${text.length} chars). Head ${HEAD_CHARS} and tail ${TAIL_CHARS} retained. Full raw output is persisted in local session store] ...\n`
  return `${head}${notice}${tail}`
}

/** Sanitize and defensively truncate tool-result blocks within budget. */
function sanitizeToolResultBlocks(blocks: readonly ContentBlock[]): { blocks: ContentBlock[]; modified: boolean } {
  let changed = false
  const sanitized: ContentBlock[] = []

  for (const block of blocks) {
    if (block.type === 'text' && block.text.length > MAX_TOOL_OUTPUT_CHARS) {
      changed = true
      sanitized.push({
        type: 'text',
        text: truncateTextUnderBudget(block.text),
      })
    } else if (block.type === 'tool-result') {
      const nested = sanitizeToolResultBlocks(block.content)
      if (nested.modified) {
        changed = true
        sanitized.push({
          ...block,
          content: nested.blocks,
        })
      } else {
        sanitized.push(block)
      }
    } else {
      sanitized.push(block)
    }
  }

  return { blocks: sanitized, modified: changed }
}

/**
 * Pure block coalescing operator:
 * Appends current blocks to previous blocks; merges adjacent pure text blocks with `\n\n`.
 */
export function coalesceBlocks(
  previousBlocks: readonly ContentBlock[],
  currentBlocks: readonly ContentBlock[],
): ContentBlock[] {
  const merged: ContentBlock[] = [...previousBlocks]
  for (const block of currentBlocks) {
    const last = merged[merged.length - 1]
    if (last && last.type === 'text' && block.type === 'text') {
      merged[merged.length - 1] = {
        type: 'text',
        text: `${last.text}\n\n${block.text}`,
      }
    } else {
      merged.push(block)
    }
  }
  return merged
}

/**
 * Transform durable conversation messages into clean, wire-safe outbound messages.
 * Pure function: returns the original `messages` array if untouched (reference invariance),
 * or a clean new message array if defensive transformations were applied.
 */
export function transformMessages(
  messages: readonly Message[],
  _options: TransformOptions = {},
): Message[] {
  if (messages.length === 0) return messages as Message[]

  let modified = false
  const staged: Message[] = []
  const pendingToolCalls = new Map<ToolCallId, { name?: string }>()
  const knownToolCalls = new Set<ToolCallId>()
  let hasEncounteredDialogue = false

  // Helper to flush synthetic tool results for unclosed tool calls
  function flushPendingToolCalls() {
    if (pendingToolCalls.size === 0) return
    modified = true
    for (const [toolCallId] of pendingToolCalls) {
      staged.push(
        createToolResultMessage({
          callId: toolCallId,
          content: [{ type: 'text', text: SYNTHETIC_TOOL_RESULT_TEXT }],
          isError: true,
        }),
      )
    }
    pendingToolCalls.clear()
  }

  for (const msg of messages) {

    // 0. System messages
    if (msg.role === 'system') {
      if (hasEncounteredDialogue) {
        // In-history system message: convert into user directive
        modified = true
        const text = extractTextFromBlocks(msg.content)
        staged.push(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: `[System Directive]: ${text}` }],
          }),
        )
      } else {
        staged.push(msg)
      }
      continue
    }

    hasEncounteredDialogue = true

    // 1. User messages (can carry tool results, commentary text, or fresh prompts)
    if (msg.role === 'user') {
      const toolResults = msg.content.filter(b => b.type === 'tool-result')
      const textBlocks = msg.content.filter(b => b.type === 'text')

      // Mark which pending tool calls are successfully satisfied by this user turn
      for (const res of toolResults) {
        if (res.type === 'tool-result') {
          pendingToolCalls.delete(res.toolCallId)
        }
      }

      // If user starts fresh non-tool conversation (e.g. conversational text)
      // while other pending tool calls remain unclosed, heal those orphans before this turn
      if (textBlocks.length > 0 && pendingToolCalls.size > 0) {
        flushPendingToolCalls()
      }

      // Check for reverse-orphan tool results and oversized outputs
      let userTurnModified = false
      const sanitizedContent: ContentBlock[] = []

      for (const block of msg.content) {
        if (block.type === 'tool-result') {
          if (!knownToolCalls.has(block.toolCallId)) {
            // Reverse-orphan tool-result: downgrade to text representation
            userTurnModified = true
            modified = true
            const rawText = extractTextFromBlocks(block.content)
            const safeText = truncateTextUnderBudget(rawText)
            sanitizedContent.push({
              type: 'text',
              text: `[Historical Tool Result for ${block.toolCallId}]: ${safeText || '(no output)'}`,
            })
          } else {
            // Valid tool-result: apply bounded budget truncation
            const sanitized = sanitizeToolResultBlocks(block.content)
            if (sanitized.modified) {
              userTurnModified = true
              modified = true
              sanitizedContent.push({
                ...block,
                content: sanitized.blocks,
              })
            } else {
              sanitizedContent.push(block)
            }
          }
        } else {
          sanitizedContent.push(block)
        }
      }

      if (userTurnModified) {
        staged.push(
          freezeMessage({
            ...msg,
            content: sanitizedContent,
          }),
        )
      } else {
        staged.push(msg)
      }
      continue
    }

    // 2. Assistant messages
    if (msg.role === 'assistant') {
      // If previous assistant calls were still unclosed when new assistant begins, auto-heal them
      flushPendingToolCalls()

      // Track newly emitted tool calls first
      for (const tc of msg.content) {
        if (tc.type === 'tool-call') {
          pendingToolCalls.set(tc.id, { name: tc.name })
          knownToolCalls.add(tc.id)
        }
      }

      // Defense (#5773): Filter out empty text blocks that crash Claude API (HTTP 400 text cannot be empty)
      const hasEmptyText = msg.content.some(b => b.type === 'text' && b.text.trim().length === 0)
      const sanitizedContent = hasEmptyText
        ? msg.content.filter(b => !(b.type === 'text' && b.text.trim().length === 0))
        : msg.content

      const toolCalls = sanitizedContent.filter(b => b.type === 'tool-call')
      const textBlocks = sanitizedContent.filter(b => b.type === 'text')
      const reasoningBlocks = sanitizedContent.filter(b => b.type === 'reasoning')

      // Case A: Message has tool calls or valid non-empty text blocks
      if (toolCalls.length > 0 || textBlocks.length > 0) {
        if (hasEmptyText) {
          modified = true
          staged.push(
            freezeMessage({
              ...msg,
              content: sanitizedContent,
            }),
          )
        } else {
          // Reference invariance preserved when no modification needed
          staged.push(msg)
        }
        continue
      }

      // Case B: Defense (#5466): assistant has neither text nor tool calls (either empty originally or after stripping empty text)
      modified = true
      const newContent: ContentBlock[] = []

      if (reasoningBlocks.length > 0) {
        // Promote reasoning text into content while preserving reasoning blocks
        const combinedReasoning = reasoningBlocks.map(b => (b.type === 'reasoning' ? b.text : '')).join('\n')
        newContent.push({ type: 'text', text: combinedReasoning })
        newContent.push(...reasoningBlocks)
      } else {
        // Absolute empty assistant turn: inject fallback placeholder
        newContent.push({ type: 'text', text: FALLBACK_EMPTY_ASSISTANT_TEXT })
      }

      staged.push(
        freezeMessage({
          ...msg,
          content: newContent,
        }),
      )
      continue
    }

    // Other roles
    staged.push(msg)
  }

  // Final Guard: If conversation ends with unclosed tool-calls, flush them
  flushPendingToolCalls()

  // 3. Turn Alternation Coalescer
  // Check if adjacent same-role messages exist (skipping plugin boundaries to preserve prefix cache)
  let needsCoalesce = false
  for (let i = 1; i < staged.length; i++) {
    const curr = staged[i]
    const prev = staged[i - 1]
    if (curr && prev && curr.role === prev.role && curr.source?.kind !== 'plugin' && prev.source?.kind !== 'plugin') {
      needsCoalesce = true
      break
    }
  }

  if (!needsCoalesce) {
    if (!modified) return messages as Message[]
    return staged
  }

  // Perform lossless block coalescing across consecutive same-role messages
  modified = true
  const coalesced: Message[] = []

  for (const msg of staged) {
    const prev = coalesced[coalesced.length - 1]
    if (prev && prev.role === msg.role && prev.source?.kind !== 'plugin' && msg.source?.kind !== 'plugin') {
      const mergedBlocks = coalesceBlocks(prev.content, msg.content)
      coalesced[coalesced.length - 1] = freezeMessage({
        ...prev,
        content: mergedBlocks,
      })
    } else {
      coalesced.push(msg)
    }
  }

  return coalesced
}
