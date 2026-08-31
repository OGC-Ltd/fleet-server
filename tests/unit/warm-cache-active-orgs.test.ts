/**
 * The sweep warms organisations somebody is reading — not every organisation
 * that exists.
 *
 * The sweep is O(orgs x caches) and walks orgs sequentially, so its cost grows
 * with the customer list while its benefit grows with how many fleets are being
 * looked at, which is usually one. Measured 2026-08-31, the day the platform
 * went from two organisations to four: `fleet-state` is meant to rebuild every
 * 60 s and the real gaps between rebuilds of one key were 96-129 s, clustering
 * at 120 s. The sweep no longer fitted inside its own interval and ran back to
 * back — 151 slow builds totalling 347 s in one 28-minute window, on a two-vCPU
 * box that also runs a 2-second telemetry poll.
 *
 * Two properties have to hold together, and testing either alone would let the
 * other regress:
 *
 *   · the FIRST sweep still primes every organisation, so no key is ever
 *     uncomputed and no request can block on a cold build;
 *   · every sweep after it skips organisations nobody has read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { createWarmCache, startCacheWarmer } from '../../src/lib/warm-cache.js'

const built: string[] = []

// refreshMs 0 so the sweep never skips a key as "still fresh" — this test is
// about WHICH ORGS it visits, and a freshness skip would hide that.
createWarmCache<string>({
  name:        'test-active-orgs',
  refreshMs:   0,
  warmKeysFor: (orgId) => [`${orgId}|k`],
  compute:     async (key) => { built.push(key); return key },
})

// Re-imported per test so `get` is the same instance the registry holds.
const cache = createWarmCache<string>({
  name:        'test-active-orgs-read',
  refreshMs:   0,
  warmKeysFor: (orgId) => [`${orgId}|r`],
  compute:     async (key) => { built.push(key); return key },
})

const orgsWarmed = () => [...new Set(built.map(k => k.split('|')[0]))].sort()

// The cache store and the activity map are module state and outlive a test, so
// the clock has to move FORWARD between tests. `vi.useFakeTimers()` resets it
// to the real now, which after a test that advanced 61 s leaves the clock
// BEHIND entries written by the previous one — `Date.now() - fetchedAt` goes
// negative, every entry reads as fresh, and the sweep skips work it should do.
let clock = Date.now()

beforeEach(() => {
  built.length = 0
  vi.useFakeTimers()
  clock += 60 * 60_000
  vi.setSystemTime(clock)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findMany as any).mockResolvedValue([{ id: 'org_a' }, { id: 'org_b' }])
})

afterEach(() => { vi.useRealTimers() })

describe('the sweep and idle organisations', () => {
  it('primes EVERY organisation on the first pass', async () => {
    const stop = startCacheWarmer()
    await vi.waitFor(() => expect(orgsWarmed()).toEqual(['org_a', 'org_b']))
    stop()
  })

  it('warms nothing on later passes when nobody has read anything', async () => {
    const stop = startCacheWarmer()
    await vi.waitFor(() => expect(orgsWarmed()).toEqual(['org_a', 'org_b']))

    built.length = 0
    await vi.advanceTimersByTimeAsync(61_000)

    expect(built).toEqual([])
    stop()
  })

  it('warms only the organisation that was read', async () => {
    const stop = startCacheWarmer()
    await vi.waitFor(() => expect(orgsWarmed()).toEqual(['org_a', 'org_b']))

    // A read is what marks an org active. Warming must NOT count, or every org
    // would keep itself alive forever and the filter would do nothing.
    await cache.get('org_a|r')
    built.length = 0

    await vi.advanceTimersByTimeAsync(61_000)

    expect(orgsWarmed()).toEqual(['org_a'])
    stop()
  })

  it('drops an organisation again once it goes quiet', async () => {
    const stop = startCacheWarmer()
    await vi.waitFor(() => expect(orgsWarmed()).toEqual(['org_a', 'org_b']))

    await cache.get('org_a|r')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(orgsWarmed()).toContain('org_a')

    // Run past the 15-minute activity window with no further reads. The org
    // stays warm for the sweeps INSIDE that window — that is the point of it —
    // so the assertion is about the sweeps after it, not the ones during.
    await vi.advanceTimersByTimeAsync(16 * 60_000)

    built.length = 0
    await vi.advanceTimersByTimeAsync(61_000)

    expect(built).toEqual([])
    stop()
  })
})
