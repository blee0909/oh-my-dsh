import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '../src/index.ts'

describe('Layer 3 Forward Compatibility: ignorable Marker in append (#5463)', () => {
  it('allows appending custom extension events marked with ignorable: true', () => {
    const session = Session.create(SessionId('ignorable-test'))

    // Third-party plugins append out-of-tree events
    type AppendParams = Parameters<typeof session.append>
    const customEvent = session.append(
      'plugin/my-custom-event' as unknown as AppendParams[0],
      { status: 'active', meta: 123 } as unknown as AppendParams[1],
      { ignorable: true },
    )

    expect(customEvent.type).toBe('plugin/my-custom-event')
    expect(customEvent.ignorable).toBe(true)

    // Snapshot should carry ignorable: true
    const snapshots = session.snapshotEvents()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.ignorable).toBe(true)
  })

  it('reconstructs session from snapshots containing ignorable out-of-tree events without throwing', () => {
    const session = Session.create(SessionId('reconstruct-test'))
    type AppendParams = Parameters<typeof session.append>
    session.append(
      'plugin/third-party-widget' as unknown as AppendParams[0],
      { widgetId: 'w1' } as unknown as AppendParams[1],
      { ignorable: true },
    )

    const serialized = session.snapshotEvents()

    // When rehydrated in an environment without that plugin, Session.create(id, serialized)
    // must accept the unknown event because its envelope carries ignorable: true
    expect(() => {
      Session.create(SessionId('reconstruct-test-restored'), serialized)
    }).not.toThrow()
  })
})
