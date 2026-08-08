// Fleet AI Insight — an hourly operations brief written by OpenAI (gpt-5-nano
// acting as the fleet's duty analyst) over the shift in progress, framed by the
// SAME aggregates the Analytics, Drivers and Maintenance pages render.
//
// The brief leads with what has physically happened today — units through the
// gate, where they went, which fuel exceptions are open and how many of those
// are confirmed losses — because that is what the manager reading it can still
// act on. The 7-30 day aggregates set the risk verdict; they are no longer the
// headline. See collectToday and SYSTEM_PROMPT.
//
// Rendering is seamless because the model is NEVER on the request path:
// startAiInsightWarmer() generates each org's brief at boot and then every
// REFRESH_MS (1 hour), and the endpoint serves whatever is in memory
// instantly. A cold miss (first request before the boot warm finishes) kicks
// a background generation and returns { insight: null } so clients show
// their local heuristic summary until the brief lands — no spinner, no wait.
//
// No OPENAI_API_KEY → { configured: false } and clients keep the local
// summary permanently.

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import { getDriversOverview, DEFAULT_DRIVER_WINDOW_DAYS } from '../analytics/drivers-overview.cache.js'
import { getDeliveriesAnalytics } from '../analytics/deliveries.cache.js'
// The DECORATED snapshot, not fleet-snapshot.cache's raw rows. Movement state,
// the provider's connection verdict, zone containment and the open trip are all
// attached by this service rather than by the cached query — and they are
// exactly the live signals this brief is built on.
import { getFleetSnapshot } from '../telemetry/telemetry.service.js'
import { resolveEstatePlaces } from '../../lib/zone-presence.js'
// The SHARED staleness threshold, not a second copy of it. Beyond this age a
// fix cannot support a claim about what the vehicle is doing — the same rule
// the movement tracker applies before it will call a unit moving.
import { STALE_FIX_MS } from '../../lib/movement-state.js'
import { getMaintenanceHistoryCached, getOrgVehicleMaintenance, DEFAULT_HISTORY_WINDOW_DAYS } from '../telemetry/maintenance.cache.js'

export interface AiInsight {
  msg:         string
  risk:        'Low' | 'Medium' | 'High'
  activeCount: number
  totalCount:  number
  generatedAt: string
}
export interface AiInsightResponse {
  configured: boolean
  insight:    AiInsight | null
}

const REFRESH_MS = 60 * 60_000   // regenerate each org's brief hourly

/**
 * A place name as prose rather than as a database key.
 *
 * Only words that are ENTIRELY uppercase are re-cased. That is the whole
 * subtlety: it fixes the shouted grouping keys ("OPAPO", "KOGUTA PRI SCHOOL")
 * while leaving anything a human already cased alone — "Kanyabie Ober" and
 * "Main river malagarasi3" come back untouched, where a blanket title-case
 * would have flattened both.
 *
 * Single characters keep their case: "KWOYO U K" is "Kwoyo U K", not
 * "Kwoyo u k". Digits and punctuation ride along, so "FARM#212" reads
 * "Farm#212".
 *
 * Deliberately NOT applied to the feed sentences in `latest`: those are free
 * text carrying registration plates, and KTCC 759G is not a word.
 */
export function placeCase(name: string): string {
  return name.replace(/[\p{L}\p{N}#]+/gu, (word) => {
    if (word.length < 2 || word !== word.toUpperCase()) return word
    return word[0] + word.slice(1).toLowerCase()
  })
}
const insights = new Map<string, AiInsightResponse>()
const generating = new Set<string>()

// ── facts: the same aggregates the three dashboard pages consume ────────────

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const halfDelta = (values: number[]) => {
  if (values.length < 2) return null
  const half = Math.max(1, Math.floor(values.length / 2))
  const cur = sum(values.slice(-half)), prev = sum(values.slice(-2 * half, -half))
  return prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null
}

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

/**
 * TODAY, on the ground — the shift the operator is actually standing in.
 *
 * The brief used to be built entirely from 7-, 14- and 30-day aggregates, which
 * is why it read like a monthly report: an operator at 09:00 was told about
 * 30-day tonnage trends and never about the seventy units that had just gone
 * through the gate. Those windows still frame the risk call, but the lead
 * sentence has to be this morning's movement and this morning's exceptions.
 *
 * Every figure here is measured from rows we already own:
 *
 *   - a run is DISPATCHED when the paperwork was raised, and LEFT THE GATE only
 *     once lib/yard-departure watched it clear the barrier (feed id `yd-<id>`).
 *     On this fleet the two routinely differ by hours — about a quarter of open
 *     dispatches are still standing in the yard — so collapsing them into one
 *     number would report trucks as gone that are parked outside the office.
 *   - a fuel issue NEEDS INVESTIGATING only on a LOSS verdict: the level stayed
 *     down, so the fuel really went. PENDING is still inside its settle window
 *     and REDISTRIBUTION has been actively disproved (see fuel-adjudication) —
 *     lumping those in is how "19 raised" becomes 19 chases, which is the exact
 *     over-reporting the adjudicator was written to stop.
 */
export async function collectToday(orgId: string) {
  const dayStart = fleetDayStart()
  const now = new Date()

  const [dispatches, returnedToday, openRuns, openBeforeToday, gateRows, thefts, feedCounts, overspeeding, latestFeed] = await Promise.all([
    prisma.dispatch.findMany({
      where:  { organisationId: orgId, dispatchedAt: { gte: dayStart } },
      select: { id: true, destination: true, actualReturnAt: true },
    }),
    // Runs CLOSED today, whenever they were raised. A round trip on this fleet
    // runs about nineteen hours, so most of what comes home this morning left
    // yesterday — filtering returns by dispatch date would have missed nearly
    // all of them.
    prisma.dispatch.count({
      where: { organisationId: orgId, actualReturnAt: { gte: dayStart } },
    }),
    // What is out RIGHT NOW — on the SAME footing as the gate office's own
    // board, because the two get read side by side and a dashboard that
    // disagrees with the paperwork is worth less than no dashboard.
    //
    // CANCELLED is excluded and that is not a detail: measured on SUKARI
    // (2026-08-05) 47 of the 114 dispatches with no return time were cancelled
    // runs, so "114 units are out" would have overstated the fleet on the road
    // by 70%. OVERDUE is carried separately because the provider's own late
    // flag is the one an operator acts on.
    //
    // SCOPED TO THE FLEET DAY, which is the correction. Unbounded, this counted
    // every run the provider had ever left open: 193 on 2026-08-05 against 142
    // on the factory's own screen and 139 open runs raised that day. The tail is
    // paperwork nobody closed — 31 runs older than a day, six older than a week
    // — and it grows for ever, so the figure drifted further from the truth
    // every day it ran.
    //
    // The cost of the bound is the overnight case, and it is real: this fleet's
    // round trip is about nineteen hours, so a unit released at 22:00 is still
    // on the road at 06:00 and is NOT counted here after midnight. The factory's
    // board has the same blind spot, and agreeing with the operator's own record
    // beats being separately right. `outNowStale` carries what the bound drops,
    // so the difference is always visible rather than silently missing.
    prisma.dispatch.findMany({
      where:  {
        organisationId: orgId,
        actualReturnAt: null,
        status:         { in: ['DISPATCHED', 'OVERDUE'] },
        dispatchedAt:   { gte: dayStart },
      },
      select: { destination: true, status: true },
    }),
    // Open runs raised BEFORE today. Not added to `outNow` — reported beside it
    // so a long tail shows up as the reconciliation problem it is instead of
    // inflating the headline.
    prisma.dispatch.count({
      where: {
        organisationId: orgId,
        actualReturnAt: null,
        status:         { in: ['DISPATCHED', 'OVERDUE'] },
        dispatchedAt:   { lt: dayStart },
      },
    }),
    // Gate crossings OBSERVED today, keyed on when the crossing happened rather
    // than on when the paperwork was raised.
    //
    // This used to look up departures for dispatches RAISED today, which is a
    // different question and routinely the wrong one: the fleet dispatches
    // through the night, so a unit that cleared the barrier at 00:14 against a
    // run raised at 21:25 yesterday was reported as no departure at all. The
    // feed showed the crossing; the brief said "nothing has been dispatched".
    prisma.notification.findMany({
      where:  { organisationId: orgId, occurredAt: { gte: dayStart }, feedId: { startsWith: 'yd-' } },
      select: { feedId: true },
    }),
    prisma.fuelTheft.findMany({
      where:  { vehicle: { organisationId: orgId }, detectedAt: { gte: dayStart } },
      select: { verdict: true, stolenMl: true },
    }),
    // Today's Live Feed, by kind. Grouped rather than fetched: zone crossings
    // alone run to ~2,900 a day on Kasulu and no brief needs them individually.
    prisma.notification.groupBy({
      by:      ['alertType'],
      where:   { organisationId: orgId, occurredAt: { gte: dayStart } },
      _count:  { _all: true },
    }),
    prisma.vehicleAlert.count({
      where: { organisationId: orgId, type: 'overspeeding', triggeredAt: { gte: dayStart } },
    }),
    // The newest lines an operator would actually have read. Zone crossings are
    // excluded for the reason lib/zone-taxonomy documents at length: a tractor
    // working a field crosses boundaries continuously, and they crowd out
    // everything that matters.
    prisma.notification.findMany({
      where:   {
        organisationId: orgId,
        occurredAt:     { gte: dayStart },
        alertType:      { notIn: ['ZONE_ENTRY', 'ZONE_EXIT'] },
      },
      orderBy: { occurredAt: 'desc' },
      take:    5,
      select:  { text: true, severity: true, alertType: true, occurredAt: true },
    }),
  ])

  // The runs behind today's crossings — needed for the destination split, and
  // deliberately NOT restricted to today's paperwork (see the query above).
  const departedIds = [...new Set(gateRows.map(r => r.feedId.slice(3)))]
  const departedRuns = departedIds.length
    ? await prisma.dispatch.findMany({
        where:  { id: { in: departedIds } },
        select: { destination: true },
      })
    : []

  // Dispatchers type the destination freehand and the casing wanders, so group
  // on the same UPPER(TRIM()) key DispatchDestination uses. Unnamed destinations
  // are counted apart rather than pooled under a made-up label.
  //
  // GROUPED on the upper key, PRESENTED in place case — the two are different
  // jobs. The key has to be uppercase or OPAPO and Opapo count as two places;
  // the label does not, and quoting the key put six shouted names in one
  // sentence ("5 to OPAPO, 5 to KOGUTA PRI SCHOOL, 4 to ADEK"), which reads as
  // a brief losing its temper about a normal morning.
  const tally = (rows: Array<{ destination: string | null }>) => {
    const byDest = new Map<string, number>()
    let notRecorded = 0
    for (const r of rows) {
      const key = r.destination?.trim().toUpperCase()
      if (!key) { notRecorded++; continue }
      byDest.set(key, (byDest.get(key) ?? 0) + 1)
    }
    const ranked = [...byDest.entries()]
      .map(([destination, units]) => ({ destination: placeCase(destination), units }))
      .sort((a, b) => b.units - a.units)
    return { ranked, notRecorded }
  }

  const gate = tally(departedRuns)
  const out  = tally(openRuns)
  const overdue = openRuns.filter(r => r.status === 'OVERDUE').length

  const verdicts = (v: string) => thefts.filter(t => t.verdict === v)
  const losses   = verdicts('LOSS')

  return {
    asOfLocal: clockFmt.format(now),
    /** 'this morning' before noon, so the model cannot narrate an afternoon as one. */
    sinceLabel: Number(clockFmt.format(now).slice(0, 2)) < 12 ? 'this morning' : 'so far today',
    /**
     * Has anything actually happened yet?
     *
     * The fleet day starts at local midnight, so a brief generated in the small
     * hours is asked to describe a shift that has not begun — and the first
     * version of this prompt dutifully narrated it: "left gate: 0 this morning;
     * no destinations listed. Fuel issues raised: 0". Four zeros is not a
     * briefing. Stated as one boolean so the prompt can branch on it instead of
     * inferring emptiness from a scatter of zeroes it has to check one by one.
     *
     * A day with nothing raised is NOT necessarily quiet: this fleet's round
     * trip is about nineteen hours, so at 02:00 there can be no new paperwork
     * and still be sixty-seven units on the road and four home since midnight.
     */
    quiet: dispatches.length === 0 && thefts.length === 0
      && gateRows.length === 0 && returnedToday === 0 && openRuns.length === 0,
    /** Paperwork raised today. Not the same as anything having moved. */
    dispatchesRaised: dispatches.length,
    /** Gate crossings OBSERVED today, whenever the run was raised. */
    leftGate:         departedIds.length,
    /** Raised today but not yet seen past the barrier. */
    stillInYard:      Math.max(0, dispatches.length - departedIds.length),
    /** Runs CLOSED today — units that have got back. */
    returned:         returnedToday,
    /**
     * Units out on a live run right now, on the factory's own definition:
     * released today and not yet back. CANCELLED paperwork excluded.
     */
    outNow:           openRuns.length,
    /** Of those, flagged late by the provider. */
    outNowOverdue:    overdue,
    /**
     * Runs still open from BEFORE today. Almost always paperwork the provider
     * never closed rather than units genuinely still on the road, which is why
     * it is not in `outNow`. Never narrated — it is here so the gap between our
     * figure and the factory's board is inspectable.
     */
    outNowStale:      openBeforeToday,
    /** Where today's gate departures went. */
    byDestination:    gate.ranked.slice(0, 6),
    destinationsNotShown: Math.max(0, gate.ranked.length - 6),
    destinationNotRecorded: gate.notRecorded,
    /** Where the units currently out are headed. */
    outNowByDestination: out.ranked.slice(0, 6),
    outNowDestinationsNotShown: Math.max(0, out.ranked.length - 6),
    fuelIssues: {
      raised:            thefts.length,
      needInvestigating: losses.length,
      stillSettling:     verdicts('PENDING').length,
      ruledOut:          verdicts('REDISTRIBUTION').length,
      unverifiable:      verdicts('UNVERIFIED').length,
      litresConfirmedLost: losses.length
        ? Math.round(losses.reduce((s, t) => s + t.stolenMl, 0) / 100) / 10
        : 0,
    },
    /** Today's Live Feed by kind, plus the newest lines worth quoting. */
    feed: {
      byKind: Object.fromEntries(
        feedCounts
          .map(r => [r.alertType ?? 'other', r._count._all] as const)
          .sort((a, b) => b[1] - a[1]),
      ),
      overspeedingAlerts: overspeeding,
      latest: latestFeed.map(n => ({
        at:       clockFmt.format(n.occurredAt),
        severity: n.severity,
        text:     n.text,
      })),
    },
  }
}

/** One decorated snapshot row, as much of it as this module reads. */
interface SnapRow {
  vehicleId?: string
  vehicleType?: string | null
  /** ISO time of this vehicle's newest ping. Null when it has never reported. */
  capturedAt?: string | null
  lat?: number | null
  lng?: number | null
  speedKmh?: number | null
  engineOn?: boolean
  lowFuel?: boolean
  inMaintenance?: boolean
  connectionOnline?: boolean | null
  movement?: { state?: 'moving' | 'idling' | 'resting' } | null
  zones?: { breach?: boolean } | null
  trip?: { leg?: string; destination?: string | null } | null
}

/**
 * What the fleet is doing THIS MINUTE.
 *
 * The counts an operator reads off the topbar, taken from the same decorated
 * snapshot the map renders so the card cannot disagree with the screen beside
 * it. `movement.state` is the tracker's verdict, not a speed threshold: a truck
 * stopped at a weighbridge with the engine running is idling, not parked, and
 * inventing a "speed > 0" rule here would have contradicted the vehicle cards.
 *
 * Connection is the PROVIDER's verdict (`connectionOnline`), never inferred
 * from fix age — see lib/connection-state. `null` means the poller has no
 * current answer, which is why unknown is counted separately rather than being
 * folded into offline and reported as a fleet-wide outage.
 */
export function collectLiveState(snapshot: SnapRow[]) {
  const state = (s: string) => snapshot.filter(v => v.movement?.state === s).length
  const legs = new Map<string, number>()
  for (const v of snapshot) {
    const leg = v.trip?.leg
    if (leg) legs.set(leg, (legs.get(leg) ?? 0) + 1)
  }

  const online  = snapshot.filter(v => v.connectionOnline === true).length
  const offline = snapshot.filter(v => v.connectionOnline === false).length
  /**
   * Does anything actually know the fleet's connectivity?
   *
   * `connectionStatus` reads the poller's in-memory map, so a process that
   * polls nothing — or one whose sweep has stalled — sees every unit as `null`.
   * Reported as counts alone that state is indistinguishable from a total
   * outage, and it read exactly that way: "0 online, 0 in transit", risk High,
   * for a fleet that was fine. So when nothing is known the counts are withheld
   * rather than published as zeroes, and the brief is told to stay silent on
   * connectivity instead of asserting a blackout that is not in evidence.
   */
  const connectionKnown = online + offline > 0

  /**
   * "Active" has to mean RUNNING NOW, and the fleet it is measured against has
   * to be the fleet that reports.
   *
   * The snapshot takes each vehicle's newest ping with no recency bound, so
   * `engine_on` is whatever its last-ever frame said. Measured on SUKARI
   * (2026-08-05) that made the headline "54/597 active" out of:
   *
   *   597 vehicles in the registry, of which only 280 have EVER sent a ping —
   *        317 carry no telemetry at all and could never be in the numerator.
   *    54 whose newest ping says engine on, of which just 20 were within the
   *        hour. Nineteen last reported over a WEEK ago; the oldest had been
   *        stuck "active" for 566 days on a frame from early 2025.
   *
   * So the count is bounded by the same staleness rule the movement tracker
   * uses — a vehicle that has stopped reporting is not running, we have simply
   * not heard from it — and the denominator is the reporting fleet. On that
   * data the pair goes from 54/597 to 20/280.
   *
   * The card no longer prints that ratio (see collectFacts), so these two feed
   * the risk verdict and the hourly log rather than the screen — but the
   * bounding still matters there for exactly the same reason: a fleet judged
   * on 566-day-old engine flags is judged on nothing.
   *
   * `vehicles` is kept for context and for the risk verdict, but it is NOT the
   * denominator and the units missing from it are not "down".
   */
  const fresh = (v: SnapRow) =>
    v.capturedAt != null && Date.now() - Date.parse(v.capturedAt) <= STALE_FIX_MS

  return {
    vehicles:      snapshot.length,
    /** Vehicles that have ever sent telemetry — the fleet the ratio is over. */
    reporting:     snapshot.filter(v => v.capturedAt != null).length,
    /** Never reported at all: in the registry, invisible to telemetry. */
    noTelemetryEver: snapshot.filter(v => v.capturedAt == null).length,
    connectionKnown,
    online:        connectionKnown ? online  : null,
    offline:       connectionKnown ? offline : null,
    connectionUnknown: snapshot.filter(v => v.connectionOnline == null).length,
    /** Engine on AND heard from within the hour. */
    enginesOn:     snapshot.filter(v => v.engineOn && fresh(v)).length,
    /** Engine flag still true on a ping too old to support it. */
    engineOnButStale: snapshot.filter(v => v.engineOn && !fresh(v)).length,
    inTransit:     state('moving'),
    idling:        state('idling'),
    parked:        state('resting'),
    lowFuel:       snapshot.filter(v => v.lowFuel).length,
    inMaintenance: snapshot.filter(v => v.inMaintenance).length,
    insideKeepOutZone: snapshot.filter(v => v.zones?.breach).length,
    /** Units on an open run, by where the geometry says they are on it. */
    onRunByLeg: Object.fromEntries([...legs.entries()].sort((a, b) => b[1] - a[1])),
  }
}

/**
 * WHERE the fleet is working, by the estate's own named features.
 *
 * The operator's question — "how many units are in the factory area, how many
 * out on the farms" — is answered from each unit's own fix resolved against the
 * plotted overlay, not from the provider's idea of place. `resolveEstatePlaces`
 * returns every containing feature most specific first, so a machine inside
 * FARM#212 and also inside the 2500 Ha Area is attributed to FARM#212: the
 * smallest true statement rather than the largest.
 *
 * Only units the provider currently calls online are placed. An offline unit's
 * last known fix is where it was when it stopped reporting, which on a fleet
 * with 20-minute coverage gaps is not where it is working now.
 */
async function collectWorkingAreas(orgId: string, snapshot: SnapRow[]) {
  const byArea = new Map<string, { area: string; category: string; units: number }>()
  let positioned = 0
  let outsideAnyEstateFeature = 0

  for (const v of snapshot) {
    if (v.connectionOnline !== true) continue
    if (v.lat == null || v.lng == null) continue
    positioned++
    const places = await resolveEstatePlaces(orgId, v.lat, v.lng)
    const here = places[0]
    if (!here) { outsideAnyEstateFeature++; continue }
    // Same treatment as the destinations — the estate's own feature names are
    // shouted ("FACTORY SITE", "FARM#212") and the brief reads them aloud.
    const row = byArea.get(here.id) ?? { area: placeCase(here.name), category: here.category, units: 0 }
    row.units++
    byArea.set(here.id, row)
  }

  const ranked = [...byArea.values()].sort((a, b) => b.units - a.units)
  return {
    positioned,
    byArea: ranked.slice(0, 6),
    areasNotShown: Math.max(0, ranked.length - 6),
    outsideAnyEstateFeature,
  }
}

async function collectFacts(orgId: string) {
  const [snapshot, drivers, deliveries, history, maint, today] = await Promise.all([
    getFleetSnapshot(orgId) as Promise<SnapRow[]>,
    getDriversOverview(orgId, DEFAULT_DRIVER_WINDOW_DAYS),
    getDeliveriesAnalytics(orgId, 30),
    getMaintenanceHistoryCached(orgId, DEFAULT_HISTORY_WINDOW_DAYS),
    getOrgVehicleMaintenance(orgId),
    collectToday(orgId),
  ])

  // Areas are resolved from the snapshot, so this waits on it rather than
  // joining the parallel batch above.
  const working = await collectWorkingAreas(orgId, snapshot)

  const fleetNow    = collectLiveState(snapshot)
  // These used to be printed by the card as an "N/M active:" prefix; it now
  // renders the brief alone, because the brief's first sentence already says
  // how the fleet is running and two disagreeing headline numbers is one too
  // many. They stay on the response because the deployed dash bundle is not
  // upgraded in lockstep with this service and older builds still read them —
  // dropping the fields would paint "undefined/undefined active" until dash
  // catches up. Running now, over the fleet that reports; see collectLiveState
  // for why neither is the registry figure.
  const activeCount = fleetNow.enginesOn
  const totalCount  = fleetNow.reporting
  const roster      = drivers.drivers
  const weekAgo     = Date.now() - 7 * 86_400_000
  const hist30      = history.slice(-30)
  const hist14      = history.slice(-14)

  const facts = {
    // ── right now: online/offline, in transit, idling, breaches ──
    fleetNow,
    // ── where the fleet is working, by estate feature ──
    working,
    // ── the shift in progress — see collectToday ──
    today,
    // ── Drivers page ──
    drivers: {
      count: roster.length,
      avgRating: roster.length ? Math.round(roster.reduce((s, d) => s + d.rating, 0) / roster.length * 100) / 100 : null,
      below4:    roster.filter(d => d.rating < 4).length,
      fuelTheftCases:    sum(roster.map(d => d.fuelTheftCases)),
      overspeedingCases: sum(roster.map(d => d.overspeedingCases)),
      topByTonnes: roster.slice(0, 3).map(d => ({ name: d.fullName, tonnes: d.tonnes, trips: d.trips, rating: d.rating })),
      lowestRated: [...roster].sort((a, b) => a.rating - b.rating).slice(0, 2)
        .map(d => ({ name: d.fullName, rating: d.rating, overspeedingCases: d.overspeedingCases })),
    },
    // ── Analytics page (30-day deliveries) ──
    deliveries30d: {
      trips: deliveries.totals.trips,
      tonnes: deliveries.totals.tonnes,
      distanceKm: deliveries.totals.distanceKm,
      timelyPct: deliveries.deliveries.total > 0
        ? Math.round((deliveries.deliveries.timely / deliveries.deliveries.total) * 100) : null,
      interrupted: deliveries.deliveries.interrupted,
      tonnesTrendPctHalfOverHalf: halfDelta(deliveries.byDay.map(d => d.tonnes)),
      tripsTrendPctHalfOverHalf:  halfDelta(deliveries.byDay.map(d => d.trips)),
      topProducts: deliveries.products.slice(0, 3).map(p => ({ product: p.product, tonnes: p.tonnes })),
      busiestDepots: deliveries.depots.slice(0, 3).map(d => ({ depot: d.depot, trips: d.trips })),
    },
    // ── Maintenance page ──
    maintenance: {
      last30d: {
        distanceKm: sum(hist30.map(h => h.distanceKm)),
        overspeedingIncidents: sum(hist30.map(h => h.overspeedingCount)),
        fuelInconsistencyIncidents: sum(hist30.map(h => h.fuelInconsistencyCount)),
        incidentTrendPctHalfOverHalf: halfDelta(hist14.map(h => h.overspeedingCount + h.fuelInconsistencyCount)),
      },
      last7d: {
        servicesCompleted: Object.values(maint.services).flat().filter(r => Date.parse(r.servicedAt) > weekAgo).length,
        garageVisits:      Object.values(maint.visits).flat().filter(r => Date.parse(r.enteredAt) > weekAgo).length,
      },
    },
  }
  return { facts, activeCount, totalCount }
}

// ── generation ──────────────────────────────────────────────────────────────

/**
 * What the brief is FOR.
 *
 * The manager reading this card is standing in a live shift, not reviewing a
 * quarter. The prompt this replaced asked for "overall fleet health, the most
 * significant data trend, and a recommended action" over 30-day aggregates, and
 * it produced exactly what it asked for: fluent, unfalsifiable executive prose
 * ("fleet health is stable; consider tightening driver monitoring") that told
 * the operator nothing they could act on before lunch.
 *
 * The answer to that was NOT more material. A first pass let the model spend a
 * 70-word budget across the day, the aggregates and an action, and it filled
 * the space — driver ratings, busiest depots, 30-day tonnage — which is the
 * same fault wearing better numbers. The fleet manager's own words for it were
 * "it's too much".
 *
 * So the brief is now three sentences and a hard list of what may appear in
 * them: fleet health, this morning's gate movement split by destination, and
 * today's fuel exceptions with the number that actually needs chasing.
 * Everything else in the payload exists ONLY to inform the risk verdict. The
 * model chooses the wording; it never chooses the content.
 *
 * The unit counts are NOT among them, and no longer because they would stutter
 * against a prefix: the card prints the brief alone now, and the ratio was
 * taken off it deliberately. Reinstating it in prose would put it straight
 * back. `online`, `inTransit`, `idling` and `parked` are what sentence 1
 * reports; the active/reporting pair sets the health verdict and stays out of
 * the text.
 */
export const SYSTEM_PROMPT =
  'You are the duty operations analyst for a Kenyan haulage fleet, briefing the fleet manager mid-shift. ' +
  'You receive a JSON object of MEASURED facts. Write FOUR OR FIVE short sentences, at most 95 words in total, ' +
  'covering these in order: ' +
  '(1) How the fleet is running right now and your risk verdict, from `fleetNow`: how many are online, and the ' +
  'split between `inTransit`, `idling` and `parked` — e.g. "The fleet is working steadily, with 96 units online, ' +
  '41 in transit and 18 idling." Do NOT state how many units are active out of how many in total, and never write ' +
  'a figure of the "N of M" or "N/M" form about the fleet: that ratio was deliberately removed from the card, and ' +
  'the online, in-transit, idling and parked counts are what describe the fleet here. ' +
  'If `fleetNow.connectionKnown` is false, `online` and `offline` are null because the poller has no current ' +
  'answer — SAY NOTHING about connectivity at all, describe the fleet from the movement counts alone, and never ' +
  'write "0 online", which would assert a fleet-wide blackout that is not in evidence. ' +
  '`fleetNow.reporting` is the fleet that sends telemetry and `fleetNow.vehicles` is the whole registry; the ' +
  'difference (`noTelemetryEver`) is units that have NEVER reported, which is a provisioning gap, NOT units that ' +
  'are down or offline. Never describe them as either, and never raise the risk level because of them. ' +
  '(2) Today\'s movement: how many left the gate (`today.leftGate`, with `today.sinceLabel` used verbatim) broken ' +
  'down by destination from `today.byDestination`, AND how the day stands — `today.outNow` units still out ' +
  '(`today.outNowOverdue` of them overdue) and `today.returned` back already. E.g. "We have had 70 units leave the ' +
  'gate this morning, with 20 going to WEIGHBRIDGE X and 50 going to WEIGHBRIDGE Y; 67 are still out, 24 of them ' +
  'overdue, and 4 have returned." Use two sentences for this if one will not carry it. ' +
  '`outNow` is units released TODAY and not yet back — the same definition the factory\'s own dispatch board ' +
  'uses, so the two agree. Report it and `returned` even when `dispatchesRaised` and `leftGate` are 0, and never ' +
  'say the fleet has done nothing while units are out. `today.outNowByDestination` says where those units are ' +
  'headed; use it if the gate split is empty. Never mention `outNowStale` or add it to anything: those are open ' +
  'runs from earlier days, which is unclosed paperwork rather than units on the road. ' +
  '(3) Where the fleet is working now, from `working.byArea` — name the areas and how many units are in each, ' +
  'e.g. "On the ground, 22 units are working FARM#212 and 9 are at the FACTORY SITE." ' +
  '(4) Today\'s exceptions: fuel issues from `today.fuelIssues.raised` and `.needInvestigating`, plus ' +
  '`today.feed.overspeedingAlerts` and `fleetNow.insideKeepOutZone` when either is above zero — e.g. "There are 19 ' +
  'fuel issues raised, 5 of which need investigating, and 3 overspeeding alerts." ' +
  '(5) OPTIONAL, only if it earns its words: the single most notable line from `today.feed.latest`, retold in your ' +
  'own words with its time — e.g. "Latest: KTCB 295U flagged for a fuel drop at 09:12." Prefer a critical or ' +
  'warning severity. Skip this sentence entirely if the latest items are routine. ' +
  'STAY ON THE LIVE SHIFT. Do not mention 30-day trends, tonnage, deliveries, timeliness, driver names, ratings, ' +
  'conduct cases, depots, products, maintenance schedules, services or garage visits: those figures are in the ' +
  'payload ONLY to inform your risk verdict, and naming any of them in the text is a failure. Do not add a ' +
  'recommendation or a closing remark. ' +
  'THE NUMBERS ARE THE POINT. Quote them exactly as given; never estimate, re-derive, round differently or invent ' +
  'one. `leftGate` is units SEEN clearing the barrier and is the figure sentence 2 reports — never substitute ' +
  '`dispatchesRaised`, which is only the paperwork. `raised` fuel issues are not all actionable: only ' +
  '`needInvestigating` are confirmed losses, and sentence 4 must keep the two apart. `online`, `inTransit`, ' +
  '`idling` and `parked` are four different counts — never add them together or use one for another. Name ' +
  'destinations and areas EXACTLY as spelled in the JSON. ' +
  'WRITE PROSE, NOT A FIELD DUMP. Never print a JSON key — not "leftGate", "needInvestigating", "dispatchesRaised", ' +
  '"outNow", "outNowOverdue", "outNowStale" nor any other — and never use the "label: value" form. Say "138 units ' +
  'are still out", never "outNow stands at 138". Begin with a capital letter and write complete sentences. ' +
  'Agree singular and plural with the actual figure — "There is 1 fuel issue raised", never "There are 1 fuel ' +
  'issues" — and write "none of which" rather than "0 of which". Write the risk level in lower case inside the ' +
  'sentence ("risk is medium"), since it is prose and not a label. ' +
  'DO NOT NARRATE ZEROES. NEVER write the digit 0 in front of a noun — not "0 in transit", not "0 idling", not ' +
  '"0 overspeeding alerts", not "0 units". If a count is zero, either leave it out entirely (preferred) or fold ' +
  'the absence into words as part of a larger clause: "158 parked and nothing moving", "no overspeeding alerts". ' +
  'A brief that omits an empty figure is CORRECT and shorter; one that lists zeroes is the failure. ' +
  'The fleet day begins at local midnight, so early in it there is genuinely nothing to ' +
  'report, and a brief is allowed to be SHORT. If `today.quiet` is true, the gate sentence ' +
  'becomes exactly "Nothing has been dispatched yet today." — but ONLY then: when `outNow` or `returned` is above ' +
  'zero the day is not empty, so report those instead of claiming nothing has happened. ' +
  'If `today.fuelIssues.raised` is 0 and there are no ' +
  'overspeeding alerts or keep-out breaches, the exceptions sentence becomes exactly "No exceptions have been ' +
  'raised today." If `working.byArea` is empty, drop the working sentence entirely rather than reporting that no ' +
  'area is occupied. Never list zero figures one after another, and never write "unknown", "no data", ' +
  '"not reported" or "none listed". ' +
  'No markdown, no preamble, no bullet points, no hedging. ' +
  'Classify overall operational risk with this rubric — the level MUST match the tone of your msg: ' +
  '"Low" = broadly positive (most units online, few confirmed fuel losses, no keep-out breaches, stable or ' +
  'improving 30-day trends); ' +
  '"Medium" = notable but contained issues or mixed signals; ' +
  '"High" = ONLY for serious, systemic problems (a large share of the fleet offline or down, repeated confirmed ' +
  'fuel losses, multiple keep-out breaches, sharply worsening incidents, or 30-day timeliness under ~50%). ' +
  'Never pair a positive summary with High risk, and never call risk High off `raised` fuel issues that have not ' +
  'been confirmed as losses, nor off `connectionUnknown`, which means the poller has no answer rather than that ' +
  'the units are down. Reply with STRICT JSON: {"msg": string, "risk": "Low"|"Medium"|"High"}.'

/**
 * Every figure the facts justify, as written text.
 *
 * Taken from the SERIALISED facts rather than from a hand-listed set of fields,
 * so a number is legitimate if it appears anywhere the model could have read
 * it: a count, a volume, a clock reading in the feed, or a digit inside a name
 * it is quoting back ("FARM#212", "KTCB 295U", "MUFINDI - EX 16"). Thousands
 * separators are stripped so 18,640 and 18640 are the same figure.
 */
function citableFigures(facts: unknown): Set<string> {
  const out = new Set<string>()
  for (const m of JSON.stringify(facts).matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0])
  return out
}

/**
 * Did the model print a field name instead of writing English?
 *
 * Same reasoning as `fabricatedFigures` below: the prompt forbids it, and a
 * prompt is a request. Observed in production on 2026-08-05 — "Today outNow
 * stands at 138, with no overdue units" — where every figure was measured and
 * correct, so the fabrication guard had no reason to fire. A brief that names
 * its own JSON keys reads as a leaked debug line to the one person it is
 * written for.
 *
 * Syntactic and cheap, like its sibling: any camelCase token from the facts
 * payload appearing verbatim in the prose. Ordinary English never contains
 * `outNowOverdue`, so there is nothing to weigh up.
 */
const FACT_KEYS = [
  'leftGate', 'stillInYard', 'dispatchesRaised', 'outNow', 'outNowOverdue', 'outNowStale',
  'outNowByDestination', 'byDestination', 'destinationsNotShown', 'destinationNotRecorded',
  'needInvestigating', 'fuelIssues', 'inTransit', 'connectionKnown', 'noTelemetryEver',
  'insideKeepOutZone', 'byArea', 'sinceLabel', 'fleetNow', 'outNowDestinationsNotShown',
]

export function leakedFieldNames(msg: string): string[] {
  return FACT_KEYS.filter(k => msg.includes(k))
}

/**
 * Did the model invent a number?
 *
 * The prompt tells it to quote figures exactly and never to derive one. A
 * prompt is a request, not a guarantee — and this brief's whole value is that a
 * fleet manager can act on it, so a plausible-looking figure nobody measured is
 * the single worst thing it could produce. Measured during rollout, the model
 * summed `inTransit + idling + parked` into a total that appears nowhere in the
 * data, which is exactly the failure this catches.
 *
 * Deliberately CHEAP and syntactic: every digit-run in the reply must appear in
 * the facts. That admits a wrong number pulled from the wrong field — no string
 * check can catch that — but it makes invention out of whole cloth impossible,
 * and it cannot be argued with the way a "be accurate" instruction can.
 *
 * Returns the offending figures, so the rejection is diagnosable in the log
 * rather than silent.
 */
export function fabricatedFigures(msg: string, facts: unknown): string[] {
  const citable = citableFigures(facts)
  const used    = [...msg.replace(/,(?=\d{3}\b)/g, '').matchAll(/\d+(?:\.\d+)?/g)].map(m => m[0])
  return [...new Set(used.filter(n => !citable.has(n)))]
}

/**
 * The same brief, written from the facts alone.
 *
 * Not a degraded mode: on a missing key, a timeout, a malformed reply or a
 * fabricated figure, the operator still gets the sentences. The model buys
 * phrasing, not information — so anything it would have said that this cannot
 * was never measured in the first place.
 *
 * Sentences are emitted only for figures that exist, so an empty shift yields a
 * shorter brief rather than a row of zeroes.
 */
export function buildFleetFallback(facts: {
  fleetNow: ReturnType<typeof collectLiveState>
  working:  Awaited<ReturnType<typeof collectWorkingAreas>>
  today:    Awaited<ReturnType<typeof collectToday>>
}): string {
  const { fleetNow: f, working, today } = facts
  const parts: string[] = []

  const running: string[] = []
  if (f.connectionKnown && f.online != null) running.push(`${f.online} online`)
  if (f.inTransit) running.push(`${f.inTransit} in transit`)
  if (f.idling)    running.push(`${f.idling} idling`)
  if (f.parked)    running.push(`${f.parked} parked`)
  parts.push(running.length
    ? `The fleet is running with ${running.join(', ')}.`
    : 'The fleet is quiet.')

  if (today.leftGate > 0) {
    const split = today.byDestination.map(d => `${d.units} to ${d.destination}`)
    parts.push(split.length
      ? `${today.leftGate} ${today.leftGate === 1 ? 'unit has' : 'units have'} left the gate ${today.sinceLabel}, with ${split.join(' and ')}.`
      : `${today.leftGate} ${today.leftGate === 1 ? 'unit has' : 'units have'} left the gate ${today.sinceLabel}.`)
  } else if (today.outNow === 0) {
    parts.push('Nothing has been dispatched yet today.')
  }

  // What is on the road, and what is home. On a nineteen-hour round trip these
  // are the two figures that describe the day, and neither depends on anything
  // having been raised since midnight.
  const run: string[] = []
  if (today.outNow > 0) {
    run.push(`${today.outNow} ${today.outNow === 1 ? 'unit is' : 'units are'} out`
      + (today.outNowOverdue > 0 ? `, ${today.outNowOverdue} of them overdue` : ''))
  }
  if (today.returned > 0) run.push(`${today.returned} ${today.returned === 1 ? 'has' : 'have'} returned today`)
  if (run.length) parts.push(`${run.join(', and ')}.`)

  if (working.byArea.length) {
    const where = working.byArea.slice(0, 3).map(a => `${a.units} in ${a.area}`)
    parts.push(`On the ground, ${where.join(' and ')}.`)
  }

  const exceptions: string[] = []
  if (today.fuelIssues.raised > 0) {
    exceptions.push(
      `${today.fuelIssues.raised} fuel ${today.fuelIssues.raised === 1 ? 'issue' : 'issues'} raised`
      + (today.fuelIssues.needInvestigating > 0
          ? `, ${today.fuelIssues.needInvestigating} of which need investigating`
          : ', none of which need investigating'),
    )
  }
  if (today.feed.overspeedingAlerts > 0) exceptions.push(`${today.feed.overspeedingAlerts} overspeeding alerts`)
  if (f.insideKeepOutZone > 0)           exceptions.push(`${f.insideKeepOutZone} inside a keep-out zone`)
  parts.push(exceptions.length ? `There are ${exceptions.join(', and ')}.` : 'No exceptions have been raised today.')

  return parts.join(' ')
}

async function generateFor(orgId: string): Promise<void> {
  if (generating.has(orgId)) return
  generating.add(orgId)
  try {
    const { facts, activeCount, totalCount } = await collectFacts(orgId)
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(facts) },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body   = await res.json() as { choices?: { message?: { content?: string } }[] }
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { msg?: string; risk?: string }
    if (!parsed.msg) throw new Error('empty insight from model')

    // Accepted only if every figure in it was measured. There is already a
    // complete brief written from the facts, so the bar for taking the model's
    // wording is that it invented nothing.
    const invented = fabricatedFigures(parsed.msg, facts)
    const leaked   = leakedFieldNames(parsed.msg)
    const msg = invented.length || leaked.length ? buildFleetFallback(facts) : parsed.msg
    if (invented.length) {
      logger.warn(
        { orgId, invented, rejected: parsed.msg },
        'AI insight: model quoted figures that are not in the data — the facts-only brief stands',
      )
    }
    if (leaked.length) {
      logger.warn(
        { orgId, leaked, rejected: parsed.msg },
        'AI insight: model printed field names instead of prose — the facts-only brief stands',
      )
    }

    const risk = (['Low', 'Medium', 'High'] as const).find(r => r === parsed.risk) ?? 'Medium'
    insights.set(orgId, {
      configured: true,
      insight: { msg, risk, activeCount, totalCount, generatedAt: new Date().toISOString() },
    })
    // The TEXT, not just the level. The card is the only place this is
    // otherwise visible, and that needs a browser and a login — so a brief that
    // reads badly (a narrated zero, a leaked field name) could not be diagnosed
    // from the box at all. One line an hour per organisation.
    // `brief`, NOT `msg` — pino owns `msg` for the log message itself, so a
    // field of that name is silently overwritten and the text never appears.
    logger.info(
      { orgId, risk, brief: msg, source: invented.length ? 'facts' : 'model', live: facts.fleetNow },
      'AI insight refreshed',
    )
  } catch (err) {
    // The model is unreachable or unusable — but the facts are already
    // measured, so the operator gets the brief anyway rather than falling back
    // to the client's local heuristic.
    try {
      const { facts, activeCount, totalCount } = await collectFacts(orgId)
      insights.set(orgId, {
        configured: true,
        insight: {
          msg: buildFleetFallback(facts), risk: 'Medium',
          activeCount, totalCount, generatedAt: new Date().toISOString(),
        },
      })
      logger.warn({ err, orgId }, 'AI insight: model failed — the facts-only brief stands')
    } catch (inner) {
      logger.warn({ err: inner, orgId }, 'AI insight generation failed — previous brief stays')
    }
  } finally {
    generating.delete(orgId)
  }
}

// ── public API ──────────────────────────────────────────────────────────────

/** Instant, in-memory read. A cold miss triggers background generation and
 *  returns insight:null so clients render their local fallback meanwhile. */
export async function getAiInsight(orgId: string): Promise<AiInsightResponse> {
  if (!env.OPENAI_API_KEY) return { configured: false, insight: null }
  const hit = insights.get(orgId)
  if (hit) return hit
  void generateFor(orgId)
  return { configured: true, insight: null }
}

/** Hourly regeneration for every org — started from index.ts. */
export function startAiInsightWarmer(): () => void {
  if (!env.OPENAI_API_KEY) return () => {}
  let stopped = false
  const sweep = async () => {
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true } })
      for (const org of orgs) {
        if (stopped) return
        await generateFor(org.id)
      }
    } catch (err) {
      logger.warn({ err }, 'AI insight sweep failed')
    }
  }
  void sweep()
  const timer = setInterval(() => void sweep(), REFRESH_MS)
  return () => { stopped = true; clearInterval(timer) }
}
