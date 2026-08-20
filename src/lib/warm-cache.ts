// Generic warmed in-memory cache for read endpoints.
//
// The remote pooler costs ~1s PER QUERY, so any endpoint that queries the DB
// on the request path blows the UI's latency budget. Pattern (established on
// the Drivers page, now shared by the Analytics + Maintenance endpoints):
//
//  - `createWarmCache` gives a keyed stale-while-revalidate cache: cached data
//    is returned immediately (a stale entry kicks off a background refresh);
//    only a never-computed key waits on the database, once.
//  - Caches that declare `warmKeysFor` are swept by the central warmer: at
//    boot and then every REFRESH_MS, every org's declared keys are recomputed
//    in the background, so even a client's FIRST request is served from
//    memory and data is never more than one sweep stale.
//
// Caches register at module-import time; index.ts starts the warmer after the
// app (and therefore every controller + cache module) has been imported.

import { prisma } from './prisma.js'
import { logger } from './logger.js'

const REFRESH_MS = 60_000

interface Registered {
  name:    string
  keysFor: (orgId: string) => string[]
  /** Rebuild unless the entry is younger than the cache's own interval. */
  refreshIfStale: (key: string) => Promise<unknown>
}
const registry: Registered[] = []

export interface WarmCache<T> {
  /** SWR read: cached (possibly stale) data immediately; computes on first use. */
  get(key: string): Promise<T>
}

export function createWarmCache<T>(opts: {
  name: string
  /** Compute the payload for one cache key (key format is the caller's). */
  compute: (key: string) => Promise<T>
  /** Keys the warmer keeps hot for an org — omit for on-demand-only caches. */
  warmKeysFor?: (orgId: string) => string[]
  /** Entry cap for caches whose keys grow with user input (default 500) —
   *  oldest entries are evicted first. */
  maxEntries?: number
  /**
   * How old an entry may get before it is rebuilt, defaulting to the sweep
   * interval.
   *
   * Raise it for a cache whose build is expensive relative to how fast its
   * answer moves. `probe-report` costs ~36 s against the live fleet and
   * describes faults that develop over days; refreshing that every 60 s would
   * hold a throttled instance at half its capacity permanently, to publish an
   * answer that had not changed. The sweep still VISITS the key every minute —
   * it just declines to rebuild a fresh one.
   */
  refreshMs?: number
}): WarmCache<T> {
  const store = new Map<string, { data: T; fetchedAt: number; refreshing: boolean }>()
  const maxEntries = opts.maxEntries ?? 500
  const refreshMs  = opts.refreshMs ?? REFRESH_MS

  /**
   * One computation per key at a time, shared by everyone who asks for it.
   *
   * Without this the same work ran up to three times concurrently, because
   * there were two independent ways in and neither knew about the other: a
   * cold-key `get()` called `refresh` directly with nothing recording that it
   * had, and the periodic sweep calls this function through the registry,
   * bypassing the `refreshing` flag on the entry entirely.
   *
   * That is not free on this database. `open-trips` computes
   * findOpenTripsByVehicle, measured at ~6.0 s per call against the live fleet
   * (88 open trips for SUKARI). Three of those in flight together is ~18 s of
   * work on an instance with roughly 1 GB of RAM, and on 2026-08-10 03:00-04:00
   * it took the API down with it: `Query read timeout` on open-trips,
   * fleet-snapshot and dashboard-summary alike, telemetry poll ticks skipping
   * for minutes, and one poll cycle stretching to 418 s. The logs show the two
   * entry points racing plainly — "warm-cache sweep refresh failed" and
   * "warm-cache background refresh failed" for the same key, seconds apart.
   *
   * Deduplicating does not make the 6 s query faster; it stops us paying for it
   * three times over. Same shape as the frontend's services/snapshot.js, which
   * already learned this lesson against the same endpoint.
   */
  const inflight = new Map<string, Promise<T>>()

  const refresh = (key: string): Promise<T> => {
    const running = inflight.get(key)
    if (running) return running

    const p = (async () => {
      const data = await opts.compute(key)
      if (store.size >= maxEntries && !store.has(key)) {
        let oldest: string | null = null, oldestAt = Infinity
        for (const [k, e] of store) if (e.fetchedAt < oldestAt) { oldestAt = e.fetchedAt; oldest = k }
        if (oldest) store.delete(oldest)
      }
      store.set(key, { data, fetchedAt: Date.now(), refreshing: false })
      return data
    })()

    inflight.set(key, p)
    // Cleared on failure too, or one rejection would wedge the key forever and
    // the cache would serve that entry stale until the process restarted.
    // `void` because the settle handler is bookkeeping — callers await `p`.
    void p.catch(() => undefined).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
    return p
  }

  const get = async (key: string): Promise<T> => {
    const entry = store.get(key)
    if (entry) {
      if (Date.now() - entry.fetchedAt > refreshMs && !entry.refreshing) {
        entry.refreshing = true
        refresh(key).catch(err => {
          entry.refreshing = false
          logger.warn({ err, cache: opts.name, key }, 'warm-cache background refresh failed — serving stale')
        })
      }
      return entry.data
    }
    return refresh(key)
  }

  /**
   * What the sweep calls. A key the sweep has already built recently is left
   * alone, so a cache with a long `refreshMs` costs nothing on the sweeps in
   * between rather than being rebuilt every minute by the warmer while `get`
   * politely waits its turn.
   */
  const refreshIfStale = (key: string): Promise<unknown> => {
    const entry = store.get(key)
    if (entry && Date.now() - entry.fetchedAt <= refreshMs) return Promise.resolve(entry.data)
    return refresh(key)
  }

  if (opts.warmKeysFor) registry.push({ name: opts.name, keysFor: opts.warmKeysFor, refreshIfStale })
  return { get }
}

/**
 * Boot-time + interval warmer for every registered cache. One org at a time,
 * but that org's keys refresh concurrently, so a full sweep of all orgs stays
 * well inside the interval. Overlapping sweeps are skipped, not queued.
 * Returns a stop function for shutdown.
 */
export function startCacheWarmer(): () => void {
  let stopped = false
  let sweeping = false

  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true } })
      for (const org of orgs) {
        if (stopped) return
        await Promise.all(registry.flatMap(reg =>
          reg.keysFor(org.id).map(key =>
            reg.refreshIfStale(key).catch(err =>
              logger.warn({ err, cache: reg.name, key }, 'warm-cache sweep refresh failed')),
          ),
        ))
      }
    } catch (err) {
      logger.warn({ err }, 'warm-cache sweep failed')
    } finally {
      sweeping = false
    }
  }

  sweep()
    .then(() => { if (!stopped) logger.info({ caches: registry.map(r => r.name) }, 'warm caches primed') })
  const timer = setInterval(() => void sweep(), REFRESH_MS)

  return () => { stopped = true; clearInterval(timer) }
}
