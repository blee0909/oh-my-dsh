/**
 * Cross-Process Atomic Advisory File Locking for Session JSONL Persistence.
 *
 * Replaces pure in-memory Map locks to fundamentally prevent multi-process
 * concurrent write corruption (#5460) by using OS atomic file creation ('wx' flag).
 * Hardened with:
 * - Active heartbeat lease renewal via in-place FD writes (position: 0) to eliminate
 *   Windows NTFS path sharing conflicts and prevent Win32 NUL byte sparse file holes;
 * - OS-level PID liveness checks (isProcessAlive);
 * - Max stall threshold zombie reclamation;
 * - Monotonic NTP backwards clock skew defense airbags.
 *
 * @module @deepseek-ai/dsh-session-persistence-jsonl/file-lock
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'

export interface SessionLockOptions {
  /** Lease time-to-live in milliseconds before considering an unresponsive lock stale. Default: 30,000ms. */
  leaseTtlMs?: number
  /**
   * Maximum stall threshold in milliseconds before considering a lock stale regardless of PID liveness.
   * Defends against PID recycling in containerized environments and POSIX zombie processes.
   * Default: Math.max(leaseTtlMs * 10, 300_000) (5 minutes).
   */
  maxStallMs?: number
}

export interface LockPayload {
  readonly sessionId: string
  readonly pid: number
  readonly acquiredAt: number
  readonly updatedAt?: number
}

/**
 * Check whether a target PID is currently alive in the operating system.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 tests for process existence without sending a terminating signal
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    // EPERM means process exists but running under different credentials (it is ALIVE)
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'EPERM') {
      return true
    }
    // ESRCH means No such process (it is DEAD)
    return false
  }
}

/**
 * Cross-process file locker for session JSONL persistence.
 */
export class SessionFileLocker {
  private readonly lockPath: string
  private fd: number | null = null
  private readonly leaseTtlMs: number
  private readonly maxStallMs: number
  private heartbeatTimer: NodeJS.Timeout | null = null
  private acquiredAt: number = 0

  constructor(
    private readonly sessionId: SessionId,
    private readonly lockDir: string,
    options: SessionLockOptions = {},
  ) {
    this.lockPath = join(this.lockDir, `${this.sessionId}.lock`)
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000
    this.maxStallMs = options.maxStallMs ?? Math.max(this.leaseTtlMs * 10, 300_000)
  }

  acquire(): void {
    this.acquiredAt = Date.now()
    const payload: LockPayload = {
      sessionId: this.sessionId,
      pid: process.pid,
      acquiredAt: this.acquiredAt,
      updatedAt: this.acquiredAt,
    }
    const buffer = Buffer.from(JSON.stringify(payload), 'utf8')

    try {
      // 'wx' flag: Open for writing. Atomic creation fails with EEXIST if file already exists
      this.fd = openSync(this.lockPath, 'wx')
      writeSync(this.fd, buffer, 0, buffer.length, 0)
      ftruncateSync(this.fd, buffer.length)
      this.startHeartbeat()
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'EEXIST') {
        // Check if existing lockfile is stale (dead owner process or zombie stall)
        if (this.isLockStale()) {
          try {
            unlinkSync(this.lockPath)
            this.fd = openSync(this.lockPath, 'wx')
            writeSync(this.fd, buffer, 0, buffer.length, 0)
            ftruncateSync(this.fd, buffer.length)
            this.startHeartbeat()
            return
          } catch {
            // Raced with another process that reclaimed the lock first
          }
        }
        throw new SessionAlreadyOwnedError(this.sessionId)
      }
      throw err
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    // Refresh heartbeat at leaseTtlMs / 3 intervals
    const intervalMs = Math.max(Math.floor(this.leaseTtlMs / 3), 1_000)
    this.heartbeatTimer = setInterval(() => {
      this.refreshHeartbeat()
    }, intervalMs)
    // Do not block Node event loop exit
    this.heartbeatTimer.unref()
  }

  /**
   * Refreshes heartbeat in-place directly through this.fd at absolute position 0.
   * Completely avoids reopening this.lockPath by path (eliminating Windows NTFS EBUSY errors)
   * and truncates to buffer length (preventing Win32 NUL byte sparse file holes).
   */
  refreshHeartbeat(): void {
    try {
      if (this.fd !== null && existsSync(this.lockPath)) {
        const payload: LockPayload = {
          sessionId: this.sessionId,
          pid: process.pid,
          acquiredAt: this.acquiredAt,
          updatedAt: Date.now(),
        }
        const buffer = Buffer.from(JSON.stringify(payload), 'utf8')
        // In-place atomic overwrite starting explicitly at position 0
        writeSync(this.fd, buffer, 0, buffer.length, 0)
        ftruncateSync(this.fd, buffer.length)
      }
    } catch {
      // Background heartbeat failure is non-fatal; will retry next interval
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private isLockStale(): boolean {
    try {
      if (!existsSync(this.lockPath)) return true

      // 1. Try reading logical heartbeat payload first
      const raw = readFileSync(this.lockPath, 'utf8')
      if (raw.trim().length > 0) {
        try {
          const data = JSON.parse(raw) as LockPayload

          // PID Recycling & POSIX Zombie defense:
          // Check if heartbeat has completely stalled beyond maxStallMs.
          // Fall back to acquiredAt for backwards compatibility with legacy lockfiles lacking updatedAt.
          const lastActive = data.updatedAt ?? data.acquiredAt
          const now = Date.now()

          // NTP Backwards Clock Skew Airbag:
          // If now is less than lastActive (clock jumped backwards), do NOT treat as stalled!
          const isStalled = typeof lastActive === 'number'
            && now >= lastActive
            && (now - lastActive) > this.maxStallMs

          // If the recorded PID is currently ALIVE in this OS, it is strictly an active session!
          // BUT only if its heartbeats are not stalled beyond maxStallMs.
          if (typeof data.pid === 'number' && isProcessAlive(data.pid) && !isStalled) {
            return false
          }

          // The recorded PID is confirmed dead (ESRCH) or stalled beyond maxStallMs. Reclaim lockfile safely.
          return true
        } catch {
          // Unparseable JSON content: fall through to physical age check
        }
      }

      // 2. Defense against 0-byte creation race (#5460):
      // File is empty or mid-write. Check physical OS timestamp.
      // If physically created/modified within TTL window, it is an active concurrent creation; NEVER steal.
      const stat = statSync(this.lockPath)
      const now = Date.now()
      const fileTime = Math.max(stat.mtimeMs, stat.ctimeMs)
      // NTP clock skew airbag: if fileTime is in the future, physicalAge is 0 (never steal)
      const physicalAge = now >= fileTime ? now - fileTime : 0
      return physicalAge > this.leaseTtlMs
    } catch {
      return false
    }
  }

  release(): void {
    this.stopHeartbeat()

    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // ignore
      }
      this.fd = null
    }

    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath)
      }
    } catch {
      // ignore
    }
  }
}
