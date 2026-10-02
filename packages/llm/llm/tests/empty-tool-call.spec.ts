import { describe, expect, it } from 'vitest'
import { BlockAssembler, ToolCallId } from '../src/index.ts'
import { assertV4ToolResultMessage } from '../../../session/session-format-v3-to-v4/src/tool-role.ts'
import { ToolCallRecovery } from '../../../core/session/src/repair.ts'
import { SessionSeq } from '../../../core/session/src/types.ts'
import type { SessionEvent } from '../../../core/session/src/types.ts'

describe('Discussions #8653: Empty tool-call ID defense and normalization', () => {
  it('falls back to call-{index} when tool-call-delta provides an empty id', () => {
    const assembler = new BlockAssembler()
    assembler.push({
      type: 'tool-call-delta',
      index: 2,
      id: ToolCallId(''),
      argumentsDelta: '{"query":"test"}',
    })
    const blocks = assembler.blocks()
    expect(blocks).toEqual([
      {
        type: 'tool-call',
        id: ToolCallId('call-2'),
        name: '',
        arguments: '{"query":"test"}',
      },
    ])
  })

  it('falls back to call-{index} when block-end carries an empty id', () => {
    const assembler = new BlockAssembler()
    assembler.push({
      type: 'block-end',
      index: 1,
      block: {
        type: 'tool-call',
        id: ToolCallId(''),
        name: 'testTool',
        arguments: '{}',
      },
    })
    const blocks = assembler.blocks()
    expect(blocks).toEqual([
      {
        type: 'tool-call',
        id: ToolCallId('call-1'),
        name: 'testTool',
        arguments: '{}',
      },
    ])
  })

  it('preserves valid tool call IDs without alteration', () => {
    const assembler = new BlockAssembler()
    assembler.push({
      type: 'tool-call-delta',
      index: 0,
      id: ToolCallId('custom-id-99'),
      name: 'fetch',
      argumentsDelta: '{}',
    })
    assembler.push({
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: ToolCallId('custom-id-99'),
        name: 'fetch',
        arguments: '{}',
      },
    })
    const blocks = assembler.blocks()
    expect(blocks).toEqual([
      {
        type: 'tool-call',
        id: ToolCallId('custom-id-99'),
        name: 'fetch',
        arguments: '{}',
      },
    ])
  })

  it('ToolCallRecovery defensively rejects empty toolCallIds from malformed assistant messages', () => {
    const recovery = new ToolCallRecovery({ kind: 'interrupted' })
    const malformedAssistantEvent = {
      type: 'assistant/message',
      seq: SessionSeq(1),
      time: 1000,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              id: '',
              name: 'broken',
              arguments: '{}',
            },
          ],
        },
      },
    } as unknown as SessionEvent
    recovery.observe(malformedAssistantEvent)
    // Results should be empty because empty callId was rejected from pendingCalls
    const results = recovery.results()
    expect(results).toHaveLength(0)
  })

  it('assembled tool-call generates valid tool/result accepted by assertV4ToolResultMessage', () => {
    const assembler = new BlockAssembler()
    // Simulate streaming chunks with empty id from upstream model
    assembler.push({
      type: 'tool-call-delta',
      index: 0,
      id: ToolCallId(''),
      name: 'lookup',
      argumentsDelta: '{"id":123}',
    })
    const [assembledBlock] = assembler.blocks()
    expect(assembledBlock?.type).toBe('tool-call')
    if (assembledBlock?.type !== 'tool-call') throw new Error('expected tool-call')

    const callId = assembledBlock.id
    expect(callId).toBe('call-0')

    // Simulate agent loop appending corresponding tool/result
    const toolResultEvent = {
      type: 'tool/result',
      seq: 10,
      time: 2000,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `tool-result-${callId}`,
          role: 'tool',
          toolCallId: callId,
          source: { kind: 'tool', callId },
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    }

    // Must NOT throw SessionFormatError
    expect(() => {
      assertV4ToolResultMessage(toolResultEvent)
    }).not.toThrow()
  })
})
