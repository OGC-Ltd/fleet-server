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

/** Above this, a build is worth a log line — see the note in `refresh`. */
const SLOW_BUILD_MS = 1_000

/** How many caches the sweep rebuilds at once. See the note in `sweep`. */
const SWEEP_WIDTH = 2

/**
 * How long after its last read an organisation keeps being warmed.
 *
 * The sweep is O(orgs x caches) and walks orgs SEQUENTIALLY, so its cost is
 * linear in the number of customers on the platform — while the benefit is
 * linear in the number being LOOKED AT, which is usually one.
 *
 * Measured 2026-08-31, the day Menengai and West Sugar took the platform from
 * two organisations to four: `fleet-state` is meant to rebuild every 60 s and
 * the actual gaps between rebuilds of one key were 96-129 s, clustering at
 * 120 s. The sweep had stopped fitting inside its own interval and was running
 * back to back, permanently. In one 28-minute window it logged 151 slow builds
 * totalling 347 s — `fleet-state` 46 x 2.76 s, `fleet-tank-state` 42 x 2.79 s,
 * `machine-summary` 42 x 1.55 s — on a box with two vCPUs that also runs a
 * 2-second telemetry poll. Everything else on the instance was competing with
 * a cache sweep that never stopped.
 *
 * Four organisations x seventeen caches is 68 keys a sweep. With one operator
 * on one organisation, 51 of those rebuilds are work nobody will read.
 *
 * Fifteen minutes is long enough to cover someone switching between two or
 * three fleets and back, and short enough that an organisation nobody has
 * opened all day costs nothing.
 */
const ACTIVE_ORG_MS = 15 * 60_000

/** orgId → when a cache was last READ for it. Writes come from `get`. */
const lastRead = new Map<string, number>()

/**
 * The organisation a cache key belongs to.
 *
 * Every key in the registry starts with the org id; what follows is the
 * cache's own business, and the separator is not consistent — `fleet-state`
 * uses `|`, `maintenance-history` uses `:`. Splitting on either is enough,
 * because a cuid contains neither.
 */
const orgOfKey = (key: string): string => key.split(/[|:]/)[0] ?? key

/**
 * Has anything READ data for this organisation recently?
 *
 * Exported because the cache sweep is not the only per-org job on a timer.
 * `startAiInsightWarmer` regenerates a brief for every organisation hourly, and
 * its fact-gathering reads through these caches — so before this existed, that
 * job marked all four organisations active every hour and held the cache sweep
 * at full width for fifteen minutes at a time regardless of who was looking.
 * Measured 2026-08-31, that is why scoping the cache sweep alone cut the build
 * load 3x rather than 4x.
 */
export function isOrgActive(orgId: string): boolean {
  return (lastRead.get(orgId) ?? 0) > Date.now() - ACTIVE_ORG_MS
}

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
  /**
   * What is held for this key RIGHT NOW, without building or refreshing
   * anything. Undefined for a key nobody has read yet.
   *
   * For the caller that already knows what changed and can splice the change
   * into the cached value more cheaply than a rebuild. `open-trips` is the
   * case this exists for: a rebuild is measured at ~6 s for an organisation
   * (see the note on `inflight`), while the single dispatch that just arrived
   * costs one indexed query. A whole-cache rebuild per webhook would be the
   * most expensive way to learn the smallest possible fact.
   *
   * It hands back the LIVE object, not a copy, so a caller that mutates it is
   * mutating the cache. That is the point, and it is safe here only because
   * readers of these caches are synchronous — they read the value out and are
   * done inside one tick. Anything else belongs in `compute`.
   *
   * It does NOT mark the entry fresh: the sweep still rebuilds on its own
   * schedule, so a patch that got something wrong is corrected within a minute
   * rather than living in memory until restart.
   */
  peek(key: string): T | undefined
  /**
   * Rebuild this key now, for a caller that knows the data has just changed
   * and cannot wait for the sweep.
   *
   * If a build is already running it may have read the database before the
   * change landed, so this does not simply join it: it waits for it and then
   * builds once more. Callers that fire together share that one extra build.
   */
  rebuild(key: string): Promise<T>
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
      // Every cache's build cost, in one place. Which endpoint is expensive is
      // otherwise invisible: the whole point of this cache is that nobody waits
      // for the build, so a query that has quietly grown to fifteen seconds
      // looks exactly like one that takes fifty milliseconds from outside. The
      // probe report sat at 36 s for weeks on that basis.
      const startedAt = Date.now()
      const data = await opts.compute(key)
      const ms = Date.now() - startedAt
      // Only the slow ones. A line per cache per sweep per org would be a
      // thousand lines a day saying nothing.
      if (ms >= SLOW_BUILD_MS) {
        logger.info({ cache: opts.name, key, ms }, 'warm-cache slow build')
      }
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
    // A READ is what marks an organisation active — deliberately here and not
    // in the sweep, which calls `refreshIfStale`. If warming counted as
    // activity every org would keep itself warm forever and this would do
    // nothing at all.
    lastRead.set(orgOfKey(key), Date.now())

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

  const peek = (key: string): T | undefined => store.get(key)?.data

  // One follow-up build per key at most, however many callers ask during the
  // build that is already running.
  const queued = new Map<string, Promise<T>>()
  const rebuild = (key: string): Promise<T> => {
    const running = inflight.get(key)
    if (!running) return refresh(key)
    const waiting = queued.get(key)
    if (waiting) return waiting
    const next = running.catch(() => undefined).then(() => {
      queued.delete(key)
      return refresh(key)
    })
    queued.set(key, next)
    return next
  }

  if (opts.warmKeysFor) registry.push({ name: opts.name, keysFor: opts.warmKeysFor, refreshIfStale })
  return { get, peek, rebuild }
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
  let primed = false

  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try {
      const all = await prisma.organisation.findMany({ select: { id: true } })

      // The FIRST sweep primes every organisation; the ones after it refresh
      // only what is being read.
      //
      // Both halves matter. Priming everything once is what stops a cold key
      // ever blocking a request — `get` waits on the database only for a key
      // that has never been computed, and after boot none has. From then on an
      // idle org's entry simply ages: a read still returns instantly from the
      // store and kicks off its own background refresh, so the cost of not
      // warming it is staleness on one screen, not latency.
      const orgs = primed ? all.filter(o => isOrgActive(o.id)) : all

      if (primed && orgs.length < all.length) {
        logger.debug(
          { warming: orgs.length, of: all.length },
          'warm-cache sweep skipping organisations nobody is reading',
        )
      }

      for (const org of orgs) {
        if (stopped) return

        // Bounded, not Promise.all over the whole registry.
        //
        // Firing every cache at once looks like it should be free — they are
        // independent queries and the database can interleave them. It is not,
        // on this instance. Concurrent builds contend for the same starved
        // buffer cache and the same fraction of a vCPU, and the measured effect
        // is close to linear: the same query run three ways at once took 3x as
        // long as it did alone. So the fan-out does not finish sooner, it just
        // makes every build slower and holds more connections while doing it.
        //
        // Measured 2026-08-20 with fifteen caches registered, a boot sweep put
        // excavator-area at 20.5 s against 8 s solo, fleet-state at 17.6 s
        // against 7 s, and fleet-tank-state at 14.0 s against 6.4 s — every one
        // of them roughly doubled by the company it was keeping.
        //
        // This is also the shape of the outage on 2026-08-10 03:00-04:00, when
        // concurrent builds produced "Query read timeout" on open-trips,
        // fleet-snapshot and dashboard-summary together and stretched one
        // telemetry poll cycle to 418 s.
        //
        // A small width keeps one slow cache from serialising the whole sweep
        // behind it while staying well short of the contention cliff.
        const jobs = registry.flatMap(reg =>
          reg.keysFor(org.id).map(key => ({ reg, key })))

        let next = 0
        await Promise.all(
          Array.from({ length: Math.min(SWEEP_WIDTH, jobs.length) }, async () => {
            for (;;) {
              const j = jobs[next++]
              if (!j || stopped) return
              await j.reg.refreshIfStale(j.key).catch(err =>
                logger.warn({ err, cache: j.reg.name, key: j.key }, 'warm-cache sweep refresh failed'))
            }
          }),
        )
      }
    } catch (err) {
      logger.warn({ err }, 'warm-cache sweep failed')
    } finally {
      sweeping = false
    }
  }

  sweep()
    .then(() => {
      primed = true
      if (!stopped) logger.info({ caches: registry.map(r => r.name) }, 'warm caches primed')
    })
  const timer = setInterval(() => void sweep(), REFRESH_MS)

  return () => { stopped = true; clearInterval(timer) }
}
