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
// ## Keys, and why the window is normalised
//
// `orgId|window|...`, pipe-separated because ISO instants contain colons and
// `orgOfKey` splits on the first of either. The org must lead, or the cache
// cannot tell which organisation an entry belongs to, and `lastRead` — which
// decides whose data is kept warm — would be recorded against a timestamp.
//
// The window token is the part that took thought. A request carries two
// INSTANTS chosen by the browser, and a key built from them can only be
// guessed at by a warmer: reproduce the string to the millisecond, or spend
// the sweep computing a key nobody asks for. So a window that is exactly one
// fleet day collapses to `d:YYYY-MM-DD` — a name the warmer can produce from
// the clock — and anything else keeps its instants as `i:<from>~<to>`. Both
// are cached; only the first is nameable in advance, and that is what makes
// the warming below possible at all.
//
// The day form is deliberately strict (see `fleetDayOf`). A window that starts
// at fleet midnight but ends at 23:00 is NOT the day, and answering it with
// one would hand back an hour nobody asked for.
//
// ## What is warmed, and what that costs
//
// One key per cache per org: today's fleet day, default sort, default page
// size — the request every reader makes on opening the tab, and the one that
// measured 2.7s cold against the production ledger.
//
// Four keys per org, and only for organisations read in the last fifteen
// minutes (ACTIVE_ORG_MS), so in practice it is four keys for whoever is
// actually looking. That restraint is the point: warm-cache.ts records what
// happened the day the platform went from two organisations to four — the
// sweep stopped fitting inside its own interval and ran back to back, 151 slow
// builds in 28 minutes on a two-vCPU box that also runs a 2-second telemetry
// poll. Warming every sort, or every recent day, would put this cache back in
// that territory for readers who mostly never leave the default view.

import { createWarmCache } from '../../lib/warm-cache.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import * as service from './incidents.service.js'
import type { SummaryQuery, InsightsQuery } from './incidents.schema.js'

/** 60s. The ledgers move on a 2-second poll and a 15-minute sweep, so a minute
 *  of staleness cannot hide a fault for longer than the sweep already does. */
const REFRESH_MS = 60_000

const DAY_MS = 86_400_000
const iso = (d: Date) => d.toISOString()

/** Today's fleet day, as the warmer names it. */
const todayKey = () => fleetDayKey(new Date()).toISOString().slice(0, 10)

/**
 * `YYYY-MM-DD` when this window is exactly one fleet day, else null.
 *
 * Strict at both ends on purpose. The start must BE fleet midnight, not merely
 * fall inside the day, and the end must reach its last minute — the dash sends
 * 23:59:59 local. A window that starts at midnight and stops at 23:00 is a
 * slice, and answering it with a whole day would hand back an hour nobody
 * asked for. Anything failing either test keeps its instants instead.
 */
function fleetDayOf(from: Date, to: Date): string | null {
  const start = fleetDayStart(from)
  if (from.getTime() !== start.getTime()) return null
  const end = start.getTime() + DAY_MS
  if (to.getTime() >= end || to.getTime() < end - 60_000) return null
  return fleetDayKey(from).toISOString().slice(0, 10)
}

/** The instants a day token stands for. Noon UTC lands inside the intended day
 *  whichever way the offset nudges it — the same anchor the migrations use. */
const dayWindow = (day: string) => {
  const from = fleetDayStart(new Date(day + 'T12:00:00Z'))
  return { from, to: new Date(from.getTime() + DAY_MS - 1_000) }
}

const windowToken = (from: Date, to: Date) => {
  const day = fleetDayOf(from, to)
  return day ? 'd:' + day : 'i:' + iso(from) + '~' + iso(to)
}

const windowOf = (token: string) => {
  if (token.startsWith('d:')) return dayWindow(token.slice(2))
  const [from, to] = token.slice(2).split('~')
  return { from: new Date(from!), to: new Date(to!) }
}

const summaryKey = (orgId: string, q: SummaryQuery) =>
  [orgId, windowToken(q.from, q.to), q.sort, q.limit, q.kind ?? ''].join('|')
const insightsKey = (orgId: string, q: InsightsQuery) =>
  [orgId, windowToken(q.from, q.to)].join('|')

/**
 * Rebuilding the query from its key rather than closing over it.
 *
 * `compute` is handed only the key — that is what makes an entry refreshable
 * in the background long after the request that created it has gone.
 */
const summaryQuery = (key: string) => {
  const [, token, sort, limit, kind] = key.split('|')
  return {
    ...windowOf(token!),
    sort: sort as SummaryQuery['sort'], limit: Number(limit),
    kind: kind || undefined,
  } as SummaryQuery
}
const insightsQuery = (key: string) => {
  const [, token] = key.split('|')
  return windowOf(token!) as InsightsQuery
}
const orgOf = (key: string) => key.split('|')[0]!

/* The one key each cache warms: today, default sort, default page size — the
   request every reader makes on opening the tab. WARM_SORT and WARM_LIMIT must
   track incidents.schema's defaults, or the warmer heats a key nobody asks
   for and every real request still pays the cold price. */
const WARM_SORT  = 'count'
const WARM_LIMIT = 50
const warmSummaryKey  = (orgId: string) =>
  [orgId, 'd:' + todayKey(), WARM_SORT, WARM_LIMIT, ''].join('|')
const warmInsightsKey = (orgId: string) => [orgId, 'd:' + todayKey()].join('|')

const speedingSummaryCache = createWarmCache<Awaited<ReturnType<typeof service.speedingSummary>>>({
  name: 'incident-speeding-summary',
  refreshMs: REFRESH_MS,
  compute: (key) => service.speedingSummary(orgOf(key), summaryQuery(key)),
  warmKeysFor: (orgId) => [warmSummaryKey(orgId)],
})

const speedingInsightsCache = createWarmCache<Awaited<ReturnType<typeof service.speedingInsights>>>({
  name: 'incident-speeding-insights',
  refreshMs: REFRESH_MS,
  compute: (key) => service.speedingInsights(orgOf(key), insightsQuery(key)),
  warmKeysFor: (orgId) => [warmInsightsKey(orgId)],
})

const faultSummaryCache = createWarmCache<Awaited<ReturnType<typeof service.faultSummary>>>({
  name: 'incident-fault-summary',
  refreshMs: REFRESH_MS,
  compute: (key) => service.faultSummary(orgOf(key), summaryQuery(key)),
  warmKeysFor: (orgId) => [warmSummaryKey(orgId)],
})

const faultInsightsCache = createWarmCache<Awaited<ReturnType<typeof service.faultInsights>>>({
  name: 'incident-fault-insights',
  refreshMs: REFRESH_MS,
  compute: (key) => service.faultInsights(orgOf(key), insightsQuery(key)),
  warmKeysFor: (orgId) => [warmInsightsKey(orgId)],
})

/* ── public surface ───────────────────────────────────────────────────────── */
//
// Same signatures as the service functions they front, so the controller reads
// the same either way. Only the FIRST page is cached: a reader paging deep into
// a list is rare, their key would be read once and then held for nothing, and
// putting the cursor in the key would let one wanderer fill memory with pages
// nobody reopens. `minCount` bypasses for the same reason — almost nothing
// sends it — and so does a search, whose key space is whatever people type.
// All three fall through to the service unchanged.

const pageable = (q: SummaryQuery) => !q.cursor && !q.minCount && !q.q

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
