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
  refresh: (key: string) => Promise<unknown>
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
}): WarmCache<T> {
  const store = new Map<string, { data: T; fetchedAt: number; refreshing: boolean }>()
  const maxEntries = opts.maxEntries ?? 500

  const refresh = async (key: string): Promise<T> => {
    const data = await opts.compute(key)
    if (store.size >= maxEntries && !store.has(key)) {
      let oldest: string | null = null, oldestAt = Infinity
      for (const [k, e] of store) if (e.fetchedAt < oldestAt) { oldestAt = e.fetchedAt; oldest = k }
      if (oldest) store.delete(oldest)
    }
    store.set(key, { data, fetchedAt: Date.now(), refreshing: false })
    return data
  }

  const get = async (key: string): Promise<T> => {
    const entry = store.get(key)
    if (entry) {
      if (Date.now() - entry.fetchedAt > REFRESH_MS && !entry.refreshing) {
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

  if (opts.warmKeysFor) registry.push({ name: opts.name, keysFor: opts.warmKeysFor, refresh })
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
            reg.refresh(key).catch(err =>
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
