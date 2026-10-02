import { describe, expect, it } from 'vitest'
import {
  isForegroundSignallingUnsupported,
  SubprocessForegroundSignallingUnsupportedError,
} from '@deepseek-ai/dsh-subprocess'
import { LocalTerminalHandle } from '../src/terminal.ts'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'
import type { IPty } from 'node-pty'

class MockPty {
  readonly pid = 100
  readonly writes: string[] = []
  write(data: string): void {
    this.writes.push(data)
  }
  resize(): void {}
  onData(): { dispose(): void } { return { dispose: () => {} } }
  onExit(): { dispose(): void } { return { dispose: () => {} } }
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

describe('Discussions #8608: Windows foreground signalling capability separation', () => {
  it('explicitly reports scoped foreground signalling unsupported for SIGKILL instead of false shell-guard refusal', async () => {
    const pty = new MockPty()
    const inspector = createWindowsProcessInspector({
      snapshot: () => [
        { pid: 100, parentPid: 0 },
        { pid: 200, parentPid: 100 },
      ],
      processState: pid => ({ started: `time-${pid}`, active: true }),
      taskkill: () => {},
    })

    const handle = new LocalTerminalHandle(pty as unknown as IPty, inspector, 100, 'win32')
    await expect(handle.signalForeground('SIGKILL')).rejects.toThrow(SubprocessForegroundSignallingUnsupportedError)
  })

  it('explicitly reports scoped foreground signalling unsupported for SIGINT without injecting \\x03 into PTY', async () => {
    const pty = new MockPty()
    const inspector = createWindowsProcessInspector({
      snapshot: () => [{ pid: 100, parentPid: 0 }],
      processState: pid => ({ started: `time-${pid}`, active: true }),
      taskkill: () => {},
    })

    const handle = new LocalTerminalHandle(pty as unknown as IPty, inspector, 100, 'win32')
    let caught: unknown
    try {
      await handle.signalForeground('SIGINT')
    } catch (err) {
      caught = err
    }

    expect(isForegroundSignallingUnsupported(caught)).toBe(true)
    expect(pty.writes).toEqual([])
  })

  it('explicitly reports scoped foreground signalling unsupported for SIGTERM without taskkill shell teardown', async () => {
    const pty = new MockPty()
    const taskkills: Array<{ pid: number; force: boolean }> = []
    const inspector = createWindowsProcessInspector({
      snapshot: () => [
        { pid: 100, parentPid: 0 },
        { pid: 200, parentPid: 100 },
      ],
      processState: pid => ({ started: `time-${pid}`, active: true }),
      taskkill: (pid, force) => { taskkills.push({ pid, force }) },
    })

    const handle = new LocalTerminalHandle(pty as unknown as IPty, inspector, 100, 'win32')
    await expect(handle.signalForeground('SIGTERM')).rejects.toThrow(SubprocessForegroundSignallingUnsupportedError)
    expect(taskkills).toEqual([])
  })
})
