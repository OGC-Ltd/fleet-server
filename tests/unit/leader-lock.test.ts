/**
 * Only one server may poll and run the background jobs, whether pm2 or a
 * container started it (src/lib/leader-lock.ts). These pin the behaviour the
 * cutover and the pm2 fallback rely on:
 *   - the first server takes the lock and goes on;
 *   - a second waits for it, says who holds it, and gives up after the wait;
 *   - a lock freed during the wait (a deploy's old process exiting) is taken;
 *   - losing the lock's connection while holding it stops the process;
 *   - so does a heartbeat that finds the lock gone, fails or times out;
 *   - releasing it ourselves does not.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  acquireLeaderLock, LeaderLockTimeout, leaderAppName, LEADER_APP_PREFIX,
  type LockClient,
} from '../../src/lib/leader-lock.js'

type Listener = (...args: unknown[]) => void

/** A pg client stand-in: `free` says whether each try gets the lock. */
function fakeClient(free: boolean[], holders: Array<Record<string, unknown>> = []) {
  const listeners: Record<string, Listener[]> = { error: [], end: [] }
  let tries = 0
  const client: LockClient & { emit(e: 'error' | 'end', ...a: unknown[]): void; tries(): number; ended: boolean; heldN: number; heartbeatError: Error | null } = {
    ended: false,
    heldN: 1,
    heartbeatError: null,
    connect: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        const ok = free[Math.min(tries, free.length - 1)] ?? false
        tries++
        return { rows: [{ ok }] }
      }
      if (sql.includes('pg_locks')) {
        if (client.heartbeatError) throw client.heartbeatError
        return { rows: [{ n: client.heldN }] }
      }
      return { rows: holders }
    }),
    end: vi.fn(async () => {
      client.ended = true
      for (const l of listeners['end']!) l()
    }),
    on(event, listener) { listeners[event]!.push(listener); return client },
    emit(event, ...args) { for (const l of listeners[event]!) l(...args) },
    tries: () => tries,
  }
  return client
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

/** A clock the fake sleep advances, so no test waits for real; `beat()` runs the heartbeat. */
function clock() {
  let t = 0
  let tick: (() => void) | null = null
  let stopped = false
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    every: (_ms: number, fn: () => void) => { tick = fn; return () => { stopped = true } },
    beat: async () => { tick?.(); await new Promise(r => setTimeout(r, 0)) },
    stopped: () => stopped,
  }
}

describe('leader lock', () => {
  it('takes a free lock at once and goes on', async () => {
    const c = fakeClient([true])
    const l = log()
    const lock = await acquireLeaderLock({ connectionString: 'x', waitMs: 90_000, log: l, onLost: vi.fn(), makeClient: () => c, ...clock() })
    expect(c.tries()).toBe(1)
    expect(l.info).toHaveBeenCalledOnce()
    expect(l.warn).not.toHaveBeenCalled()
    await lock.release()
    expect(c.ended).toBe(true)
  })

  it('waits for a lock that is freed during the wait (a deploy\'s old process exiting)', async () => {
    const c = fakeClient([false, false, true])
    const l = log()
    await acquireLeaderLock({ connectionString: 'x', waitMs: 90_000, retryMs: 5_000, log: l, onLost: vi.fn(), makeClient: () => c, ...clock() })
    expect(c.tries()).toBe(3)
    expect(l.warn).toHaveBeenCalledOnce()   // said once, not every retry
  })

  it('gives up after the wait, naming who holds it, and closes its connection', async () => {
    const holder = { application_name: `${LEADER_APP_PREFIX}ip-10-0-1-5:4242`, addr: '10.0.1.5', backend_start: '2026-11-16T08:00:00Z' }
    const c = fakeClient([false], [holder])
    const err = await acquireLeaderLock({ connectionString: 'x', waitMs: 20_000, retryMs: 5_000, log: log(), onLost: vi.fn(), makeClient: () => c, ...clock() })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LeaderLockTimeout)
    expect((err as LeaderLockTimeout).holders[0]).toContain('ip-10-0-1-5:4242 from 10.0.1.5')
    expect(c.tries()).toBe(5)               // at 0, 5, 10, 15 and 20 s
    expect(c.ended).toBe(true)
  })

  it('a zero wait refuses at the first try', async () => {
    const c = fakeClient([false])
    await expect(acquireLeaderLock({ connectionString: 'x', waitMs: 0, log: log(), onLost: vi.fn(), makeClient: () => c, ...clock() }))
      .rejects.toBeInstanceOf(LeaderLockTimeout)
    expect(c.tries()).toBe(1)
  })

  it('losing the connection while holding the lock stops the process, once', async () => {
    const c = fakeClient([true])
    const onLost = vi.fn()
    const l = log()
    await acquireLeaderLock({ connectionString: 'x', waitMs: 90_000, log: l, onLost, makeClient: () => c, ...clock() })
    c.emit('error', new Error('Connection terminated unexpectedly'))
    c.emit('end')
    expect(onLost).toHaveBeenCalledOnce()
    expect(l.error).toHaveBeenCalledOnce()
  })

  it('releasing it on shutdown is not a loss', async () => {
    const c = fakeClient([true])
    const onLost = vi.fn()
    const lock = await acquireLeaderLock({ connectionString: 'x', waitMs: 90_000, log: log(), onLost, makeClient: () => c, ...clock() })
    await lock.release()
    await lock.release()
    expect(onLost).not.toHaveBeenCalled()
    expect(c.end).toHaveBeenCalledOnce()
  })

  it('an error before the lock is held is not reported as a loss', async () => {
    const c = fakeClient([false, true])
    const onLost = vi.fn()
    const p = acquireLeaderLock({ connectionString: 'x', waitMs: 90_000, log: log(), onLost, makeClient: () => c, ...clock() })
    c.emit('error', new Error('blip'))
    await p
    expect(onLost).not.toHaveBeenCalled()
  })

  it('a heartbeat that still finds the lock changes nothing', async () => {
    const c = fakeClient([true]); const k = clock(); const onLost = vi.fn()
    await acquireLeaderLock({ connectionString: 'x', waitMs: 0, log: log(), onLost, makeClient: () => c, ...k })
    await k.beat(); await k.beat()
    expect(onLost).not.toHaveBeenCalled()
  })

  it('a heartbeat that finds the lock gone (a silent failover) stops the process and the heartbeat', async () => {
    const c = fakeClient([true]); const k = clock(); const onLost = vi.fn()
    await acquireLeaderLock({ connectionString: 'x', waitMs: 0, log: log(), onLost, makeClient: () => c, ...k })
    c.heldN = 0
    await k.beat(); await k.beat()
    expect(onLost).toHaveBeenCalledOnce()
    expect(k.stopped()).toBe(true)
  })

  it('a heartbeat that errors or times out counts as lost', async () => {
    const c = fakeClient([true]); const k = clock(); const onLost = vi.fn()
    await acquireLeaderLock({ connectionString: 'x', waitMs: 0, log: log(), onLost, makeClient: () => c, ...k })
    c.heartbeatError = new Error('Query read timeout')
    await k.beat()
    expect(onLost).toHaveBeenCalledOnce()
  })

  it('release stops the heartbeat', async () => {
    const c = fakeClient([true]); const k = clock()
    const lock = await acquireLeaderLock({ connectionString: 'x', waitMs: 0, log: log(), onLost: vi.fn(), makeClient: () => c, ...k })
    await lock.release()
    expect(k.stopped()).toBe(true)
  })

  it('names the session by host and pid, within Postgres\'s 63 bytes', () => {
    expect(leaderAppName('ip-10-0-1-5', 4242)).toBe(`${LEADER_APP_PREFIX}ip-10-0-1-5:4242`)
    expect(leaderAppName('h'.repeat(100), 1).length).toBe(63)
  })
})
