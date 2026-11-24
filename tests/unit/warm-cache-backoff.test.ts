/**
 * A build that fails is not retried on every sweep.
 *
 * A key that has never built has no entry, and a stale entry stays stale after
 * a failed refresh, so both read as "due" on the next sweep. On 2026-11-24 the
 * probe report's build hit the 55 s statement timeout for all nine
 * organisations after a restart, and the sweep restarted all nine every
 * minute: the database spent the night re-reading the same pages for builds
 * that could not finish, which kept them failing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { createWarmCache, startCacheWarmer, retryAfterMs } from '../../src/lib/warm-cache.js'

let failing = true
let attempts = 0
const cache = createWarmCache<string>({
  name:        'test-backoff',
  refreshMs:   0,
  warmKeysFor: (orgId) => [`${orgId}|b`],
  compute:     async (key) => {
    attempts++
    if (failing) throw new Error('canceling statement due to statement timeout')
    return `${key}:ok`
  },
})

let clock = Date.now() + 365 * 24 * 3_600_000

beforeEach(() => {
  failing = true
  attempts = 0
  vi.useFakeTimers()
  clock += 24 * 3_600_000
  vi.setSystemTime(clock)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findMany as any).mockResolvedValue([{ id: 'org_x' }])
})

afterEach(() => { vi.useRealTimers() })

describe('retryAfterMs', () => {
  it('waits the refresh interval, at least a minute, doubling, capped at 30 minutes', () => {
    expect(retryAfterMs(0, 1)).toBe(60_000)
    expect(retryAfterMs(0, 2)).toBe(120_000)
    expect(retryAfterMs(600_000, 1)).toBe(600_000)
    expect(retryAfterMs(600_000, 2)).toBe(1_200_000)
    expect(retryAfterMs(600_000, 3)).toBe(1_800_000)
    expect(retryAfterMs(600_000, 9)).toBe(1_800_000)
  })
})

describe('the sweep after a failed build', () => {
  it('leaves the key alone until the backoff has passed, then tries again', async () => {
    // Mark the org active so later sweeps visit it at all.
    // Failure 1 (a request), at t=0. Backoff: 60 s.
    await cache.get('org_x|b').catch(() => undefined)
    expect(attempts).toBe(1)

    // The boot sweep runs at once and must NOT retry inside the backoff. (It
    // used to: no entry read as "due".)
    const stop = startCacheWarmer()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempts).toBe(1)

    // The sweep at ~60 s is past the 60 s backoff: failure 2. Backoff: 120 s.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(2)

    // The sweep a minute later is inside the 120 s backoff: left alone.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(2)

    // The one after is past it, and this time the build succeeds; the key is
    // then served from the store.
    failing = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(3)
    expect(await cache.get('org_x|b')).toBe('org_x|b:ok')
    stop()
  })

  it('still computes for a request when nothing is cached: somebody is waiting', async () => {
    await expect(cache.get('org_y|b')).rejects.toThrow('statement timeout')
    const before = attempts
    await expect(cache.get('org_y|b')).rejects.toThrow('statement timeout')
    expect(attempts).toBe(before + 1)
  })
})
