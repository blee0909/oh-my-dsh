// @vitest-environment jsdom
/** Regression tests for Discussions #6475: Generic tool image result rendering support. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { MessageImageLoader, RenderMessageImages } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { resultImageCard } from '../src/client/tool/models/image-card-model.ts'
import { GenericToolCard } from '../src/client/tool/toolviews/GenericToolCard.tsx'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const loadImage: MessageImageLoader = vi.fn(() => Promise.reject(new Error('not used')))

const sampleRef: ImageAttachmentRef = {
  attachmentId: 'att-42' as never,
  mediaType: 'image/png',
  bytes: 4096,
  width: 800,
  height: 600,
  name: 'chart.png',
}

const settledResult = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result',
  seq: 1,
  time: 1000,
  callId: 'call-1',
  call: { name: 'show_image', argsRaw: JSON.stringify({ file_path: '/ws/shots/chart.png' }) },
  callTime: 500,
  content: [
    { type: 'text', text: 'Rendered chart successfully.' },
    { type: 'image', attachment: sampleRef } as never,
  ],
  isError: false,
  subCalls: [],
  ...over,
} as unknown as ToolResultNode)

describe('resultImageCard model derivation (Discussions #6475)', () => {
  it('returns null for running call blocks', () => {
    const running = { callId: 'call-run', name: 'show_image', argsRaw: '{}', subCalls: [] }
    expect(resultImageCard(running as never)).toBeNull()
  })

  it('returns null for error result blocks', () => {
    expect(resultImageCard(settledResult({ isError: true }))).toBeNull()
  })

  it('returns null when content carries no image blocks', () => {
    const textOnly = settledResult({ content: [{ type: 'text', text: 'no images here' }] })
    expect(resultImageCard(textOnly)).toBeNull()
  })

  it('returns null when image attachment is malformed', () => {
    const badRef = { ...sampleRef, width: -1 }
    const badResult = settledResult({ content: [{ type: 'image', attachment: badRef } as never] })
    expect(resultImageCard(badResult)).toBeNull()
  })

  it('derives image card from non-read_image tool results', () => {
    const model = resultImageCard(settledResult(), '/ws', '/home/user')
    expect(model).not.toBeNull()
    expect(model?.label).toBe('shots/chart.png')
    expect(model?.images).toEqual([{ attachment: sampleRef }])
    expect(model?.text).toBe('Rendered chart successfully.')
  })

  it('derives label from alternative path argument names and falls back gracefully', () => {
    const withPath = settledResult({
      call: { name: 'custom_plot', argsRaw: JSON.stringify({ path: '/home/user/plot.png' }) },
    })
    expect(resultImageCard(withPath, '/ws', '/home/user')?.label).toBe('~/plot.png')

    const noArgs = settledResult({
      call: { name: 'camera_capture', argsRaw: '{}' },
    })
    // Falls back to attachment name
    expect(resultImageCard(noArgs, '/ws', '/home/user')?.label).toBe('chart.png')

    const unnamedRef = { ...sampleRef, name: undefined }
    const noName = settledResult({
      call: { name: 'raw_sensor', argsRaw: '{}' },
      content: [{ type: 'image', attachment: unnamedRef } as never],
    })
    // Falls back to tool name
    expect(resultImageCard(noName, '/ws')?.label).toBe('raw_sensor')
  })

  it('joins multiple text blocks and handles image-only results', () => {
    const multiText = settledResult({
      content: [
        { type: 'text', text: 'Line 1' },
        { type: 'image', attachment: sampleRef } as never,
        { type: 'text', text: 'Line 2' },
      ],
    })
    expect(resultImageCard(multiText)?.text).toBe('Line 1\nLine 2')

    const imageOnly = settledResult({
      content: [{ type: 'image', attachment: sampleRef } as never],
    })
    expect(resultImageCard(imageOnly)?.text).toBe('')
  })
})

describe('GenericToolCard image rendering (Discussions #6475)', () => {
  it('renders no images container when result carries only text', () => {
    const textNode = settledResult({ content: [{ type: 'text', text: 'plain text' }] })
    const { container } = render(
      <GenericToolCard
        callId="c1"
        toolName="show_image"
        block={textNode}
        openFile={vi.fn()}
        loadImage={loadImage}
        t={t}
      />,
    )
    expect(container.querySelector('[data-tool-images]')).toBeNull()
  })

  it('renders images container and dispatches renderMessageImages for each image', () => {
    const renderMessageImages = vi.fn<RenderMessageImages>(({ images }) => (
      <div data-rendered-image={('attachment' in images[0]! ? images[0].attachment.attachmentId : 'preview')} />
    ))

    const secondRef: ImageAttachmentRef = {
      ...sampleRef,
      attachmentId: 'att-99' as never,
      name: 'second.png',
    }

    const multiImageResult = settledResult({
      content: [
        { type: 'text', text: 'Two images returned' },
        { type: 'image', attachment: sampleRef } as never,
        { type: 'image', attachment: secondRef } as never,
      ],
    })

    const { container } = render(
      <GenericToolCard
        callId="c1"
        toolName="show_image"
        block={multiImageResult}
        openFile={vi.fn()}
        loadImage={loadImage}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )

    const imagesContainer = container.querySelector('[data-tool-images]')
    expect(imagesContainer).not.toBeNull()

    // Dispatched twice independently to guarantee singleFit preview for each image
    expect(renderMessageImages).toHaveBeenCalledTimes(2)
    expect(container.querySelectorAll('[data-rendered-image]')).toHaveLength(2)
  })

  it('replaces flattened raw attachment JSON in output with clean text', () => {
    const node = settledResult({
      content: [
        { type: 'text', text: 'Clean result message' },
        { type: 'image', attachment: sampleRef } as never,
      ],
    })

    const { container } = render(
      <GenericToolCard
        callId="c1"
        toolName="show_image"
        block={node}
        openFile={vi.fn()}
        loadImage={loadImage}
        t={t}
      />,
    )

    // The raw attachmentId must NOT be stringified into the body text
    expect(container.textContent).not.toContain('"attachmentId": "att-42"')
    expect(container.textContent).not.toContain('"mediaType": "image/png"')
  })
})
