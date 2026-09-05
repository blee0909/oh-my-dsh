import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionFileLocker, isProcessAlive } from '../src/file-lock.ts'

describe('Layer 3 Cross-Process File Advisory Locking (SessionFileLocker) (#5460)', () => {
  let tempDir: string
  const testSessionId = SessionId('test-concurrent-session')

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-lock-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('acquires and releases the lockfile atomically', () => {
    const locker = new SessionFileLocker(testSessionId, tempDir)

    locker.acquire()
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    expect(existsSync(lockPath)).toBe(true)

    const payload = JSON.parse(readFileSync(lockPath, 'utf8'))
    expect(payload.sessionId).toBe(testSessionId)
    expect(payload.pid).toBe(process.pid)
    expect(typeof payload.acquiredAt).toBe('number')

    locker.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('rejects concurrent write acquisitions on the same session with SessionAlreadyOwnedError', () => {
    const lockerA = new SessionFileLocker(testSessionId, tempDir)
    const lockerB = new SessionFileLocker(testSessionId, tempDir)

    lockerA.acquire()

    // Second process / instance must be strictly rejected
    expect(() => lockerB.acquire()).toThrow(SessionAlreadyOwnedError)

    // After A releases, B should be able to acquire
    lockerA.release()
    expect(() => lockerB.acquire()).not.toThrow()
    lockerB.release()
  })

  it('safely reclaims stale lockfiles when previous process crashed (confirmed dead PID)', () => {
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    // Find an unused/dead PID
    let deadPid = 999999
    while (isProcessAlive(deadPid)) {
      deadPid++
    }

    const stalePayload = {
      sessionId: testSessionId,
      pid: deadPid,
      acquiredAt: Date.now() - 3600_000,
      updatedAt: Date.now() - 3600_000,
    }
    writeFileSync(lockPath, JSON.stringify(stalePayload), 'utf8')

    // Locker should identify the PID is confirmed dead in OS and reclaim it safely
    const locker = new SessionFileLocker(testSessionId, tempDir, { leaseTtlMs: 10000 })
    expect(() => locker.acquire()).not.toThrow()

    // Verify locker now owns it with current pid
    const newPayload = JSON.parse(readFileSync(lockPath, 'utf8'))
    expect(newPayload.pid).toBe(process.pid)

    locker.release()
  })

  it('does NOT steal locks from an ALIVE process even if lease TTL (30s) has elapsed', () => {
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    // Simulate a long-running active session (>30s) where owner process is THIS alive process
    const activePayload = {
      sessionId: testSessionId,
      pid: process.pid, // CURRENT ALIVE PROCESS
      acquiredAt: Date.now() - 100_000,
      updatedAt: Date.now() - 100_000,
    }
    writeFileSync(lockPath, JSON.stringify(activePayload), 'utf8')

    // Another process attempts to acquire with TTL = 10s. Since process.pid is ALIVE,
    // it MUST NOT steal the lock!
    const rivalLocker = new SessionFileLocker(testSessionId, tempDir, { leaseTtlMs: 10000 })
    expect(() => rivalLocker.acquire()).toThrow(SessionAlreadyOwnedError)

    // File must remain unmolested
    expect(existsSync(lockPath)).toBe(true)
  })

  it('does NOT steal freshly created 0-byte locks during creation race', () => {
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    // Process A creates a 0-byte file (just openSync wx, before writeFileSync)
    writeFileSync(lockPath, '', 'utf8')

    // Process B attempts acquisition with TTL = 10s. Since the file was created just now,
    // physical age is < 10s. It must strictly reject with SessionAlreadyOwnedError
    const lockerB = new SessionFileLocker(testSessionId, tempDir, { leaseTtlMs: 10000 })
    expect(() => lockerB.acquire()).toThrow(SessionAlreadyOwnedError)

    // The lockfile must remain untouched
    expect(existsSync(lockPath)).toBe(true)
  })

  it('exercises real operating system cross-process locking and crash recovery via spawn', async () => {
    // Execute a real separate Node.js process using inline node code
    const child = spawn(process.execPath, [
      '-e',
      `
        const fs = require('fs');
        const path = require('path');
        const lockPath = path.join(${JSON.stringify(tempDir)}, ${JSON.stringify(testSessionId)} + '.lock');
        const payload = { sessionId: ${JSON.stringify(testSessionId)}, pid: process.pid, acquiredAt: Date.now(), updatedAt: Date.now() };
        fs.writeFileSync(lockPath, JSON.stringify(payload), 'utf8');
        console.log('CHILD_LOCKED:' + process.pid);
        setInterval(() => {}, 1000);
      `,
    ])

    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (data) => {
        if (data.toString().includes('CHILD_LOCKED')) {
          resolve()
        }
      })
      child.on('error', reject)
    })

    // 1. Concurrent check: Parent process tries to acquire while child process is alive -> MUST FAIL
    const parentLocker = new SessionFileLocker(testSessionId, tempDir)
    expect(() => parentLocker.acquire()).toThrow(SessionAlreadyOwnedError)

    // 2. Kill the child process (simulating sudden crash)
    child.kill('SIGKILL')
    await new Promise(r => setTimeout(r, 200))

    // 3. Parent process tries to acquire -> child is confirmed dead via isProcessAlive(child.pid), so it succeeds!
    expect(() => parentLocker.acquire()).not.toThrow()
    parentLocker.release()
  })

  it('safely reclaims lock when alive PID has stalled heartbeats beyond maxStallMs (PID recycling / zombie defense)', () => {
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    // Owner is process.pid (ALIVE in this OS), but updatedAt is 400s ago (beyond 300s maxStallMs)
    const stalledPayload = {
      sessionId: testSessionId,
      pid: process.pid,
      acquiredAt: Date.now() - 400_000,
      updatedAt: Date.now() - 400_000,
    }
    writeFileSync(lockPath, JSON.stringify(stalledPayload), 'utf8')

    const locker = new SessionFileLocker(testSessionId, tempDir, { leaseTtlMs: 30000 })
    // Because it stalled for > maxStallMs, system assumes PID recycling / zombie and safely reclaims
    expect(() => locker.acquire()).not.toThrow()
    locker.release()
  })

  it('safely reclaims legacy lock format lacking updatedAt when acquiredAt has stalled beyond maxStallMs', () => {
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    // Legacy lockfile format: only acquiredAt, no updatedAt
    const legacyPayload = {
      sessionId: testSessionId,
      pid: process.pid,
      acquiredAt: Date.now() - 400_000,
    }
    writeFileSync(lockPath, JSON.stringify(legacyPayload), 'utf8')

    const locker = new SessionFileLocker(testSessionId, tempDir, { leaseTtlMs: 30000 })
    expect(() => locker.acquire()).not.toThrow()
    locker.release()
  })

  it('updates heartbeat in-place using existing file descriptor with zero NUL byte holes', () => {
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    const locker = new SessionFileLocker(testSessionId, tempDir, { leaseTtlMs: 30000 })

    locker.acquire()

    // Explicitly invoke multiple in-place heartbeat refreshes
    locker.refreshHeartbeat()
    locker.refreshHeartbeat()
    locker.refreshHeartbeat()

    const raw = readFileSync(lockPath, 'utf8')

    // Absolute zero NUL byte holes assertion
    expect(raw).not.toContain('\0')

    const parsed = JSON.parse(raw)
    expect(parsed.sessionId).toBe(testSessionId)
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.updatedAt).toBeGreaterThanOrEqual(parsed.acquiredAt)

    locker.release()
  })

  it('prevents lock theft when clock jumps backwards (NTP clock skew airbag)', () => {
    const lockPath = join(tempDir, `${testSessionId}.lock`)
    // Simulate NTP clock shifted backwards so updatedAt / mtime appears slightly in future
    const futurePayload = {
      sessionId: testSessionId,
      pid: process.pid,
      acquiredAt: Date.now() + 60_000,
      updatedAt: Date.now() + 60_000,
    }
    writeFileSync(lockPath, JSON.stringify(futurePayload), 'utf8')

    const rivalLocker = new SessionFileLocker(testSessionId, tempDir, { leaseTtlMs: 10000 })

    // Must strictly reject acquisition rather than misidentifying future stamp as expired
    expect(() => rivalLocker.acquire()).toThrow(SessionAlreadyOwnedError)
  })
})
