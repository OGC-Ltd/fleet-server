// Warmed reads for both incident ledgers.
//
// The remote pooler costs ~1s PER QUERY, and each of the Sensor Monitor's
// Speed and Malfunction tabs fires several on open — a summary, an insights
// block, a previous-period count and a capture-start probe — then another
// summary on every sort chip. That is the latency budget spent before a row
// is drawn, repeated for every reader and every refresh.
//
// So the read endpoints go through `createWarmCache`: the first request for a
// key computes once, and every request after it is served from memory while a
// stale entry refreshes in the background. Same pattern the analytics and
// maintenance endpoints already use.
//
// ## It wraps the SERVICE, not the repository
//
// Deliberate, and it was the other way round first. Caching under the service
// meant three cache entries per screen — summary, insights, prev-count — that
// were then recomposed on every request anyway, and it put a memoiser in the
// seam the service's own tests stub, so results leaked between test cases.
// Wrapping the service caches the finished payload the controller serialises:
// one entry per screen, the cursor arithmetic and the month-over-month
// composition included, and the service keeps a clean boundary to test against.
//
// ## Deliberately NOT warmed
//
// None of these declares `warmKeysFor`, so none is registered with the central
// warmer — `registry.push` is gated on that option. This is not an oversight.
// The warmer is O(orgs x caches) and walks orgs sequentially; warm-cache.ts
// records what happened the day the platform went from two organisations to
// four — the sweep stopped fitting inside its own interval and ran back to
// back, 151 slow builds in 28 minutes on a two-vCPU box that also runs a
// 2-second telemetry poll. More swept keys per org is a cost paid on every
// sweep for every organisation, to save one operator the first request of
// their session.
//
// Warming is a reasonable thing to add LATER, once there is a canonical day
// key to warm: the window arrives here as two instants chosen by the browser,
// and the warmer would have to reproduce that string exactly or spend its
// sweep on a key nobody asks for. Until then, stale-while-revalidate already
// gives us the part that matters — one database round trip per key per
// refresh, not one per request.
//
// ## Keys
//
// `orgId|...`, pipe-separated because ISO instants contain colons and
// `orgOfKey` splits on the first of either. The org must lead, or the cache
// cannot tell which organisation an entry belongs to, and `lastRead` — which
// decides whose data is kept warm — would be recorded against a timestamp.

import { createWarmCache } from '../../lib/warm-cache.js'
import * as service from './incidents.service.js'
import type { SummaryQuery, InsightsQuery } from './incidents.schema.js'

/** 60s. The ledgers move on a 2-second poll and a 15-minute sweep, so a minute
 *  of staleness cannot hide a fault for longer than the sweep already does. */
const REFRESH_MS = 60_000

const iso = (d: Date) => d.toISOString()

/** Windows arrive as instants; everything else in a key is a short token. */
const summaryKey = (orgId: string, q: SummaryQuery) =>
  [orgId, iso(q.from), iso(q.to), q.sort, q.limit, q.kind ?? ''].join('|')
const insightsKey = (orgId: string, q: InsightsQuery) =>
  [orgId, iso(q.from), iso(q.to)].join('|')

/**
 * Rebuilding the query from its key rather than closing over it.
 *
 * `compute` is handed only the key — that is what makes an entry refreshable
 * in the background long after the request that created it has gone.
 */
const summaryQuery = (key: string) => {
  const [, from, to, sort, limit, kind] = key.split('|')
  return {
    from: new Date(from!), to: new Date(to!),
    sort: sort as SummaryQuery['sort'], limit: Number(limit),
    kind: kind || undefined,
  } as SummaryQuery
}
const insightsQuery = (key: string) => {
  const [, from, to] = key.split('|')
  return { from: new Date(from!), to: new Date(to!) } as InsightsQuery
}
const orgOf = (key: string) => key.split('|')[0]!

const speedingSummaryCache = createWarmCache<Awaited<ReturnType<typeof service.speedingSummary>>>({
  name: 'incident-speeding-summary',
  refreshMs: REFRESH_MS,
  compute: (key) => service.speedingSummary(orgOf(key), summaryQuery(key)),
})

const speedingInsightsCache = createWarmCache<Awaited<ReturnType<typeof service.speedingInsights>>>({
  name: 'incident-speeding-insights',
  refreshMs: REFRESH_MS,
  compute: (key) => service.speedingInsights(orgOf(key), insightsQuery(key)),
})

const faultSummaryCache = createWarmCache<Awaited<ReturnType<typeof service.faultSummary>>>({
  name: 'incident-fault-summary',
  refreshMs: REFRESH_MS,
  compute: (key) => service.faultSummary(orgOf(key), summaryQuery(key)),
})

const faultInsightsCache = createWarmCache<Awaited<ReturnType<typeof service.faultInsights>>>({
  name: 'incident-fault-insights',
  refreshMs: REFRESH_MS,
  compute: (key) => service.faultInsights(orgOf(key), insightsQuery(key)),
})

/* ── public surface ───────────────────────────────────────────────────────── */
//
// Same signatures as the service functions they front, so the controller reads
// the same either way. Only the FIRST page is cached: a reader paging deep into
// a list is rare, their key would be read once and then held for nothing, and
// putting the cursor in the key would let one wanderer fill memory with pages
// nobody reopens. `minCount` bypasses for the same reason — almost nothing
// sends it. Both fall through to the service unchanged.

const pageable = (q: SummaryQuery) => !q.cursor && !q.minCount

export const speedingSummary = (orgId: string, q: SummaryQuery) =>
  pageable(q) ? speedingSummaryCache.get(summaryKey(orgId, q)) : service.speedingSummary(orgId, q)

export const faultSummary = (orgId: string, q: SummaryQuery) =>
  pageable(q) ? faultSummaryCache.get(summaryKey(orgId, q)) : service.faultSummary(orgId, q)

export const speedingInsights = (orgId: string, q: InsightsQuery) =>
  speedingInsightsCache.get(insightsKey(orgId, q))

export const faultInsights = (orgId: string, q: InsightsQuery) =>
  faultInsightsCache.get(insightsKey(orgId, q))

/* The detail lists are not cached. A detail list is keyed by VEHICLE as well as
   window and cursor, so its key space is the fleet times the days times the
   pages — thousands of entries, each read once when somebody opens one unit and
   then held for nothing. The summaries above are the shared reads; these are
   the private ones, and they go straight to the service. */
export const speedingList = service.speedingList
export const faultList    = service.faultList
