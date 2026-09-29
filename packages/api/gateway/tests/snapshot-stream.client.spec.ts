import { describe, expect, it, vi } from 'vitest'
import { RemoteSnapshotStream, type RemoteStream, type RemoteStreamItem } from '../src/client/index.ts'

interface Snapshot {
  type: 'snapshot'
  data: string
}

interface Delta {
  type: 'delta'
  diff: string
}

type Frame = Snapshot | Delta

function createMockStream(items: RemoteStreamItem<Frame>[]): RemoteStream<Frame> {
  const stream = {
    get signal() {
      return new AbortController().signal
    },
    restart: () => {},
    dispose: async () => {},
    async * [Symbol.asyncIterator]() {
      for (const item of items) {
        yield item
      }
    },
  } as unknown as RemoteStream<Frame>
  return stream
}

describe('RemoteSnapshotStream', () => {
  it('applies snapshot and deltas, and resets started flag in finally', async () => {
    let replaced: Snapshot | undefined
    const updates: Delta[] = []
    let failedError: unknown

    const acceptedItems: number[] = []
    const items: RemoteStreamItem<Frame>[] = [
      {
        generation: 1,
        value: { type: 'snapshot', data: 'initial' },
        signal: new AbortController().signal,
        accept: () => { acceptedItems.push(1) },
      },
      {
        generation: 1,
        value: { type: 'delta', diff: 'change-1' },
        signal: new AbortController().signal,
        accept: () => {},
      },
    ]

    const stream = createMockStream(items)
    const snapshotStream = new RemoteSnapshotStream<Snapshot, Delta>(stream, {
      name: 'test-stream',
      isSnapshot: (frame): frame is Snapshot => frame.type === 'snapshot',
      replace: (s) => { replaced = s },
      update: (d) => { updates.push(d) },
      failed: (e) => { failedError = e },
    })

    snapshotStream.start()
    // Repeated calls while started are inert
    snapshotStream.start()

    await snapshotStream.dispose()

    expect(replaced).toEqual({ type: 'snapshot', data: 'initial' })
    expect(updates).toEqual([{ type: 'delta', diff: 'change-1' }])
    expect(acceptedItems).toEqual([1])
    expect(failedError).toBeUndefined()
  })

  it('fails with protocol violation when delta arrives before opening snapshot', async () => {
    let failedError: unknown
    const items: RemoteStreamItem<Frame>[] = [
      {
        generation: 1,
        value: { type: 'delta', diff: 'premature' },
        signal: new AbortController().signal,
        accept: () => {},
      },
    ]

    const stream = createMockStream(items)
    const snapshotStream = new RemoteSnapshotStream<Snapshot, Delta>(stream, {
      name: 'test-stream',
      isSnapshot: (frame): frame is Snapshot => frame.type === 'snapshot',
      replace: () => {},
      update: () => {},
      failed: (e) => { failedError = e },
    })

    snapshotStream.start()
    await vi.waitFor(() => {
      expect(failedError).toBeDefined()
    })
    expect((failedError as Error).message).toContain('emitted an update before its opening snapshot')
  })

  it('fails with protocol violation when multiple opening snapshots are emitted in same generation', async () => {
    let failedError: unknown
    const items: RemoteStreamItem<Frame>[] = [
      {
        generation: 1,
        value: { type: 'snapshot', data: 'first' },
        signal: new AbortController().signal,
        accept: () => {},
      },
      {
        generation: 1,
        value: { type: 'snapshot', data: 'second' },
        signal: new AbortController().signal,
        accept: () => {},
      },
    ]

    const stream = createMockStream(items)
    const snapshotStream = new RemoteSnapshotStream<Snapshot, Delta>(stream, {
      name: 'test-stream',
      isSnapshot: (frame): frame is Snapshot => frame.type === 'snapshot',
      replace: () => {},
      update: () => {},
      failed: (e) => { failedError = e },
    })

    snapshotStream.start()
    await vi.waitFor(() => {
      expect(failedError).toBeDefined()
    })
    expect((failedError as Error).message).toContain('emitted more than one opening snapshot')
  })

  it('does not start consumption if disposed', async () => {
    let replaced = false
    const items: RemoteStreamItem<Frame>[] = [
      {
        generation: 1,
        value: { type: 'snapshot', data: 'first' },
        signal: new AbortController().signal,
        accept: () => {},
      },
    ]

    const stream = createMockStream(items)
    const snapshotStream = new RemoteSnapshotStream<Snapshot, Delta>(stream, {
      name: 'test-stream',
      isSnapshot: (frame): frame is Snapshot => frame.type === 'snapshot',
      replace: () => { replaced = true },
      update: () => {},
      failed: () => {},
    })

    await snapshotStream.dispose()
    snapshotStream.start()
    expect(replaced).toBe(false)
  })
})
