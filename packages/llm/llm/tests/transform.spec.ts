import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createMessage,
  createUserMessage,
} from '../src/message.ts'
import { ToolCallId } from '../src/brand.ts'
import {
  HEAD_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  TAIL_CHARS,
  transformMessages,
} from '../src/transform.ts'

describe('Layer 1 Outbound Message Transformation (transformMessages)', () => {
  describe('Reasoning-Only & Empty Content Defenses (#5466)', () => {
    it('synthesizes fallback placeholder text for empty assistant messages without tool calls', () => {
      const emptyAssistant = createAssistantMessage({
        content: [],
        source: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
      })

      const transformed = transformMessages([emptyAssistant])

      expect(transformed).toHaveLength(1)
      const assistant = transformed[0]!
      expect(assistant.role).toBe('assistant')
      const textBlocks = assistant.content.filter(b => b.type === 'text')
      expect(textBlocks.length).toBeGreaterThan(0)
      expect(textBlocks[0]!.text).toBe('(thinking completed without explicit text)')
    })

    it('promotes reasoning text into content when assistant message has reasoning but no text or tool calls', () => {
      const reasoningOnlyAssistant = createAssistantMessage({
        content: [{ type: 'reasoning', text: '仔细分析用户需求，应该编写排序算法...' }],
        source: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
      })

      const transformed = transformMessages([reasoningOnlyAssistant])

      expect(transformed).toHaveLength(1)
      const assistant = transformed[0]!
      expect(assistant.role).toBe('assistant')
      const textBlocks = assistant.content.filter(b => b.type === 'text')
      expect(textBlocks.length).toBeGreaterThan(0)
      expect(textBlocks[0]!.text).toBe('仔细分析用户需求，应该编写排序算法...')
      // Retain the reasoning block as well for COT passback
      const reasoningBlocks = assistant.content.filter(b => b.type === 'reasoning')
      expect(reasoningBlocks.length).toBeGreaterThan(0)
    })

    it('leaves tool-call-only turns untouched without injecting text placeholders when followed by results', () => {
      const toolCallAssistant = createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: ToolCallId('call_test_1'),
          name: 'read_file',
          arguments: '{"path":"main.ts"}',
        }],
        source: { provider: 'deepseek-official', model: 'deepseek-chat' },
      })
      const toolResultUser = createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call_test_1'),
          content: [{ type: 'text', text: 'file content' }],
        }],
        source: { kind: 'user' },
      })

      const transformed = transformMessages([toolCallAssistant, toolResultUser])

      expect(transformed).toHaveLength(2)
      // Tool-call assistant should not be injected with fallback placeholder text
      const assistantTextBlocks = transformed[0]!.content.filter(b => b.type === 'text')
      expect(assistantTextBlocks).toHaveLength(0)
    })
  })

  describe('Isolated Tool-Call Auto-Healing (#5445)', () => {
    it('synthesizes missing tool-result and coalesces with subsequent user prompt for strict alternation', () => {
      const turn1User = createUserMessage({
        content: [{ type: 'text', text: '请帮我查看文件' }],
        source: { kind: 'user' },
      })
      const turn1Assistant = createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: ToolCallId('call_orphan_1'),
          name: 'read_file',
          arguments: '{"path":"config.json"}',
        }],
        source: { provider: 'test', model: 'test' },
      })
      // The tool result was dropped due to network drop or abort, and next turn started
      const turn2User = createUserMessage({
        content: [{ type: 'text', text: '重新来过' }],
        source: { kind: 'user' },
      })

      const transformed = transformMessages([turn1User, turn1Assistant, turn2User])

      // Should coalesce the synthetic tool-result with turn2User so roles strictly alternate (User -> Assistant -> User)
      expect(transformed).toHaveLength(3)
      expect(transformed[0]!.role).toBe('user')
      expect(transformed[1]!.role).toBe('assistant')

      const coalescedUserMsg = transformed[2]!
      expect(coalescedUserMsg.role).toBe('user')
      // Content contains both the synthetic tool result and user's follow-up prompt
      const resultBlocks = coalescedUserMsg.content.filter(b => b.type === 'tool-result')
      expect(resultBlocks).toHaveLength(1)
      expect(resultBlocks[0]!.toolCallId).toBe('call_orphan_1')
      expect(resultBlocks[0]!.isError).toBe(true)

      const textBlocks = coalescedUserMsg.content.filter(b => b.type === 'text')
      expect(textBlocks).toHaveLength(1)
      expect(textBlocks[0]!.text).toBe('重新来过')
    })

    it('handles concurrent multi-tool calls with partial results and mixed commentary text', () => {
      const assistantMultiCall = createAssistantMessage({
        content: [
          { type: 'tool-call', id: ToolCallId('call_1'), name: 'read_a', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('call_2'), name: 'read_b', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('call_3'), name: 'read_c', arguments: '{}' },
        ],
        source: { provider: 'test', model: 'test' },
      })

      // User returns only call_2 result, but adds commentary text (mixed content)
      const mixedUserTurn = createUserMessage({
        content: [
          { type: 'text', text: '部分文件读取失败，只找到了 B' },
          { type: 'tool-result', toolCallId: ToolCallId('call_2'), content: [{ type: 'text', text: 'content of b' }] },
        ],
        source: { kind: 'user' },
      })

      const transformed = transformMessages([assistantMultiCall, mixedUserTurn])

      // Must have healed the missing call_1 and call_3 without duplicating call_2
      const allResults = transformed.flatMap(m => m.content).filter(b => b.type === 'tool-result')
      expect(allResults).toHaveLength(3)

      const answeredIds = allResults.map(r => r.type === 'tool-result' ? r.toolCallId : '')
      expect(answeredIds).toContain('call_1')
      expect(answeredIds).toContain('call_2')
      expect(answeredIds).toContain('call_3')

      // call_2 was real, call_1 and call_3 were synthetically marked as errors
      const call2Result = allResults.find(r => r.type === 'tool-result' && r.toolCallId === 'call_2') as { isError?: boolean } | undefined
      expect(call2Result?.isError).toBeUndefined()

      const call1Result = allResults.find(r => r.type === 'tool-result' && r.toolCallId === 'call_1') as { isError?: boolean } | undefined
      expect(call1Result?.isError).toBe(true)

      const call3Result = allResults.find(r => r.type === 'tool-result' && r.toolCallId === 'call_3') as { isError?: boolean } | undefined
      expect(call3Result?.isError).toBe(true)

      // Strict alternation: Assistant -> User
      expect(transformed).toHaveLength(2)
      expect(transformed[0]!.role).toBe('assistant')
      expect(transformed[1]!.role).toBe('user')
    })

    it('auto-heals conversations ending abruptly with dangling unclosed tool calls (tail truncation)', () => {
      const danglingAssistant = createAssistantMessage({
        content: [
          { type: 'tool-call', id: ToolCallId('call_tail_1'), name: 'fetch', arguments: '{}' },
        ],
        source: { provider: 'test', model: 'test' },
      })

      // History ends right after assistant issued the tool call (no following user message)
      const transformed = transformMessages([danglingAssistant])

      expect(transformed).toHaveLength(2)
      expect(transformed[0]!.role).toBe('assistant')
      expect(transformed[1]!.role).toBe('user')

      const tailResult = transformed[1]!.content[0]!
      expect(tailResult.type).toBe('tool-result')
      if (tailResult.type === 'tool-result') {
        expect(tailResult.toolCallId).toBe('call_tail_1')
        expect(tailResult.isError).toBe(true)
      }
    })
  })

  describe('Turn Alternation Coalescer & Provider Invariants', () => {
    it('coalesces consecutive user messages into a single alternating turn with text joined by double newline', () => {
      const user1 = createUserMessage({
        content: [{ type: 'text', text: 'First instruction.' }],
        source: { kind: 'user' },
      })
      const user2 = createUserMessage({
        content: [{ type: 'text', text: 'Second instruction.' }],
        source: { kind: 'user' },
      })
      const assistant = createAssistantMessage({
        content: [{ type: 'text', text: 'Understood.' }],
        source: { provider: 'test', model: 'test' },
      })

      const transformed = transformMessages([user1, user2, assistant])

      expect(transformed).toHaveLength(2)
      expect(transformed[0]!.role).toBe('user')
      expect(transformed[0]!.content).toHaveLength(1)
      expect(transformed[0]!.content[0]!.type).toBe('text')
      if (transformed[0]!.content[0]!.type === 'text') {
        expect(transformed[0]!.content[0]!.text).toBe('First instruction.\n\nSecond instruction.')
      }
      expect(transformed[1]!.role).toBe('assistant')
    })

    it('safely converts in-history system messages into user directives with seamless coalescence', () => {
      const leadingSystem = createMessage({
        role: 'system',
        content: [{ type: 'text', text: 'You are a helpful coding assistant.' }],
        source: { kind: 'user' },
      })
      const user1 = createUserMessage({
        content: [{ type: 'text', text: 'Write a quicksort function.' }],
        source: { kind: 'user' },
      })
      // Dynamically injected system directive mid-session
      const midSystem = createMessage({
        role: 'system',
        content: [{ type: 'text', text: 'Memory limit is 256MB.' }],
        source: { kind: 'user' },
      })
      const assistant = createAssistantMessage({
        content: [{ type: 'text', text: 'Here is the memory-optimized quicksort...' }],
        source: { provider: 'test', model: 'test' },
      })

      const transformed = transformMessages([leadingSystem, user1, midSystem, assistant])

      // Leading system is kept intact; midSystem is converted to user directive and coalesced with user1!
      expect(transformed).toHaveLength(3)
      expect(transformed[0]!.role).toBe('system')
      expect(transformed[1]!.role).toBe('user')
      expect(transformed[2]!.role).toBe('assistant')

      if (transformed[1]!.content[0]!.type === 'text') {
        expect(transformed[1]!.content[0]!.text).toBe(
          'Write a quicksort function.\n\n[System Directive]: Memory limit is 256MB.',
        )
      }
    })

    it('safely downgrades reverse-orphan tool-result blocks missing historical tool-call to text blocks', () => {
      // Suppose context window truncation dropped the earlier assistant turn that called 'call_lost_1'
      const orphanToolUser = createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call_lost_1'),
          content: [{ type: 'text', text: 'Output of forgotten call' }],
        }],
        source: { kind: 'user' },
      })
      const assistant = createAssistantMessage({
        content: [{ type: 'text', text: 'Ready for next step.' }],
        source: { provider: 'test', model: 'test' },
      })

      const transformed = transformMessages([orphanToolUser, assistant])

      expect(transformed).toHaveLength(2)
      // The tool-result should be downgraded to text to prevent Bedrock/Anthropic tool_use mismatch 400
      const userContent = transformed[0]!.content
      expect(userContent).toHaveLength(1)
      expect(userContent[0]!.type).toBe('text')
      if (userContent[0]!.type === 'text') {
        expect(userContent[0]!.text).toBe('[Historical Tool Result for call_lost_1]: Output of forgotten call')
      }
    })

    it('defensively truncates oversized tool result outputs under bounded budget preserving head and tail', () => {
      const assistantCall = createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: ToolCallId('call_giant_output'),
          name: 'cat_huge_file',
          arguments: '{}',
        }],
        source: { provider: 'test', model: 'test' },
      })

      // Generate a massive 120,000 character output (exceeding MAX_TOOL_OUTPUT_CHARS = 64,000)
      const headPrefix = 'HEAD_LOG_LINE_001_INIT_SUCCESS\n'
      const tailSuffix = '\nTAIL_LOG_LINE_999_PROCESS_EXIT_0'
      const middlePadding = 'x'.repeat(120_000 - headPrefix.length - tailSuffix.length)
      const massiveLog = `${headPrefix}${middlePadding}${tailSuffix}`

      const userToolResult = createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call_giant_output'),
          content: [{ type: 'text', text: massiveLog }],
        }],
        source: { kind: 'user' },
      })

      const transformed = transformMessages([assistantCall, userToolResult])

      expect(transformed).toHaveLength(2)
      const resBlock = transformed[1]!.content[0]!
      expect(resBlock.type).toBe('tool-result')
      if (resBlock.type === 'tool-result') {
        const textBlock = resBlock.content[0]!
        expect(textBlock.type).toBe('text')
        if (textBlock.type === 'text') {
          // Verify head is preserved
          expect(textBlock.text.startsWith(headPrefix)).toBe(true)
          // Verify tail is preserved
          expect(textBlock.text.endsWith(tailSuffix)).toBe(true)
          // Verify system guard notice is present
          expect(textBlock.text).toContain('DSH System Guard: Tool output truncated')
          // Total length must be strictly bounded (~26,000 chars << 64,000 max)
          expect(textBlock.text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS)
          expect(textBlock.text.length).toBeGreaterThan(HEAD_CHARS + TAIL_CHARS)
        }
      }
    })
  })

  describe('Normal Conversations Preservation', () => {
    it('preserves valid multi-turn messages without mutation', () => {
      const user = createUserMessage({
        content: [{ type: 'text', text: '1+1=?' }],
        source: { kind: 'user' },
      })
      const assistant = createAssistantMessage({
        content: [{ type: 'text', text: '2' }],
        source: { provider: 'test', model: 'test' },
      })

      const messages = [user, assistant]
      const transformed = transformMessages(messages)

      expect(transformed).toHaveLength(2)
      expect(transformed).toBe(messages) // Reference Invariance!
      expect(transformed[0]).toBe(user)
      expect(transformed[1]).toBe(assistant)
    })
  })
})
