/**
 * One computation per key at a time.
 *
 * The cache had two independent ways to start work and neither knew about the
 * other: a cold-key `get()` called `refresh` with nothing recording that it
 * had, and the periodic sweep calls `refresh` through the registry, bypassing
 * the `refreshing` flag on the entry. So the same key could be computed up to
 * three times concurrently.
 *
 * That is expensive here rather than merely untidy. `open-trips` computes
 * findOpenTripsByVehicle, measured at ~6.0 s per call against the live fleet;
 * three at once is ~18 s of work on a ~1 GB database instance. On 2026-08-10
 * between 03:00 and 04:00 that produced `Query read timeout` across open-trips,
 * fleet-snapshot and dashboard-summary, telemetry poll ticks skipping for
 * minutes, and a poll cycle of 418 s. The logs caught both entry points racing:
 * "sweep refresh failed" and "background refresh failed" for one key, seconds
 * apart, plus three copies of the same statement in pg_stat_activity at 91 s.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createWarmCache } from '../../src/lib/warm-cache.js'

/** A compute that blocks until released, so overlap is deterministic. */
function gatedCompute() {
  let calls = 0
  let release!: (v: string) => void
  const gate = new Promise<string>(r => { release = r })
  const compute = vi.fn(async (key: string) => {
    calls++
    await gate
    return `${key}:v${calls}`
  })
  return { compute, release: () => release('go'), calls: () => calls }
}

describe('warm-cache in-flight dedup', () => {
  it('computes once for concurrent cold-key callers', async () => {
    const g = gatedCompute()
    const cache = createWarmCache<string>({ name: 't1', compute: g.compute })

    // Three simultaneous misses — the shape a request and a sweep landing
    // together used to produce.
    const all = Promise.all([cache.get('org'), cache.get('org'), cache.get('org')])
    g.release()
    const [a, b, c] = await all

    expect(g.calls()).toBe(1)
    expect([a, b, c]).toEqual(['org:v1', 'org:v1', 'org:v1'])
  })

  it('gives every concurrent caller the same value, not one each', async () => {
    const g = gatedCompute()
    const cache = createWarmCache<string>({ name: 't2', compute: g.compute })

    const all = Promise.all([cache.get('a'), cache.get('a')])
    g.release()
    const [x, y] = await all

    expect(x).toBe(y)
  })

  it('keeps separate keys independent', async () => {
    // Dedup must be per key — collapsing two orgs onto one computation would
    // serve one org's data to the other.
    const g = gatedCompute()
    const cache = createWarmCache<string>({ name: 't3', compute: g.compute })

    const all = Promise.all([cache.get('org_a'), cache.get('org_b')])
    g.release()
    await all

    expect(g.calls()).toBe(2)
    expect(g.compute).toHaveBeenCalledWith('org_a')
    expect(g.compute).toHaveBeenCalledWith('org_b')
  })

  it('does not wedge a key after a failure', async () => {
    // The in-flight entry has to be cleared on rejection too. If it were only
    // cleared on success, one transient timeout would pin that key forever and
    // the cache would serve it stale until the process restarted — which is
    // strictly worse than the bug being fixed.
    let attempt = 0
    const compute = vi.fn(async (key: string) => {
      attempt++
      if (attempt === 1) throw new Error('query read timeout')
      return `${key}:ok`
    })
    const cache = createWarmCache<string>({ name: 't4', compute })

    await expect(cache.get('org')).rejects.toThrow('query read timeout')
    await expect(cache.get('org')).resolves.toBe('org:ok')
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('serves a cached value without recomputing', async () => {
    const compute = vi.fn(async (key: string) => `${key}:v`)
    const cache = createWarmCache<string>({ name: 't5', compute })

    await cache.get('org')
    await cache.get('org')

    expect(compute).toHaveBeenCalledTimes(1)
  })
})
