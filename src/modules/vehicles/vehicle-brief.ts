/**
 * Per-vehicle operator brief — "what has this unit been doing today", in two
 * or three sentences, for the panel that opens when an operator clicks a
 * vehicle.
 *
 * ## Why this is not built like the fleet brief
 *
 * dashboard/ai-insight regenerates every organisation's executive brief hourly
 * in the background, so the model is never on the request path. That works for
 * a handful of organisations and is impossible here: Sukari alone has 597
 * vehicles, and warming them all hourly would be tens of thousands of
 * completions a day for text almost none of which anyone opens. So this is
 * generated ON DEMAND, when a vehicle is actually selected, and cached per
 * vehicle for CACHE_TTL_MS — long enough that clicking around a few units and
 * back costs one generation each, short enough that the numbers stay current.
 *
 * ## The facts are computed here; the model only writes them up
 *
 * Every figure below is measured — the day's distance from the vehicle's own
 * fixes, the fuel from recorded fillings, the driver and the destination from
 * the open dispatch. The model is given that JSON and told to narrate it and
 * nothing else. It is never asked to estimate, infer or fill a gap, because a
 * fluent sentence is exactly where an invented number would be hardest to
 * spot.
 *
 * `buildFallback` writes the same brief deterministically from the same facts.
 * It is not a degraded mode: with no OPENAI_API_KEY, on a timeout, or on a
 * malformed reply, the operator still gets the sentence. The model buys
 * phrasing, not information.
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { shortPlaceLabel } from '../../lib/place-label.js'
import { prisma } from '../../lib/prisma.js'
import { fleetDayStart } from '../../lib/provider-time.js'
// The SHARED distance measurement, not a second copy of it — see coveredSince.
import { coveredSince, firstFixClearOfYard } from '../dispatches/dispatch.repository.js'
import { getOpenTripsCached } from '../dispatches/open-trips.cache.js'
// The DECORATED snapshot, not fleet-snapshot.cache's raw rows. `driverSource`
// and `trip` are attached by this service, not by the cached query — reading
// the cache directly left both undefined, so every brief reported a null leg
// and could not tell a dispatch driver from a standing assignment.
import { getFleetSnapshot } from '../telemetry/telemetry.service.js'
import { NO_FUEL_ARRIVED } from '../fuel/fuel-adjudication.js'

/** How long one vehicle's brief stays fresh. */
const CACHE_TTL_MS = 10 * 60_000

/** Bounded, so browsing a 597-vehicle fleet cannot grow this without limit. */
const CACHE_MAX = 300

/** Legs that mean the unit demonstrably left the yard on this run. On the other
 *  two ('at-yard', 'no-fix') there is no departure to look for. */
const LEGS_CLEAR_OF_YARD = new Set(['outbound', 'at-destination', 'returning', 'back'])

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, day: '2-digit', month: 'short',
})

/**
 * A clock reading that cannot be misread as today's.
 *
 * This fleet's median round trip is about nineteen hours, so a bare "20:56"
 * read at 05:20 says the opposite of what it means. Today's times stay bare;
 * yesterday's are marked; anything older carries its date outright, because
 * "yesterday" on a dispatch raised four days ago is just as wrong as no marker
 * at all.
 */
function localStamp(at: Date, dayStart: Date): string {
  const clock = clockFmt.format(at)
  if (at >= dayStart) return clock
  if (at >= new Date(dayStart.getTime() - 86_400_000)) return `${clock} yesterday`
  return `${clock} on ${dateFmt.format(at)}`
}

export interface VehicleBrief {
  msg: string
  /** 'model' when OpenAI wrote it, 'facts' when this did. Surfaced so the UI
   *  can be honest about what the operator is reading. */
  source: 'model' | 'facts'
  generatedAt: string
  /** The measured figures behind the sentence, so a client can show them raw. */
  facts: VehicleFacts
}

export interface VehicleFacts {
  plate: string
  driver: string | null
  /**
   * Where the name came from. 'dispatch' = the person on the run that is open
   * right now; 'assignment' = the standing vehicle→driver link; 'last-dispatch'
   * = the person on today's run, which has since been closed.
   *
   * That third case is not a nicety. Only 95 of Sukari's 597 vehicles carry a
   * standing assignment, so for the rest the open dispatch is the ONLY thing
   * naming a driver — and the moment the run closes the vehicle reverted to
   * "has no driver on record" for the rest of the day, an hour after the feed
   * had narrated the driver's name twice.
   */
  driverSource: 'dispatch' | 'assignment' | 'last-dispatch' | null
  /** Local HH:MM of the first movement today, or of the dispatch if earlier. */
  startedAt: string | null
  startedSource: 'first-movement' | 'dispatch' | null
  /** Ground covered today through the vehicle's own fixes. */
  distanceTodayKm: number | null
  /** Fuel put in today. */
  refuelledLitres: number | null
  refuelCount: number
  /** Shortened place names — see lib/place-label. */
  refuelLocations: string[]
  /** The open dispatch's own status — DISPATCHED, OVERDUE. Null when none. */
  dispatchStatus: string | null
  /** When the run was RAISED, local. Null when no dispatch is open. */
  dispatchedAtLocal: string | null
  /**
   * When the unit was first seen clear of the yard on this run, local — the
   * moment it actually left, which is a different fact from when the paperwork
   * was raised and routinely hours later. Null while it is still in the yard,
   * has not reported, or the yard has not been surveyed for this org.
   */
  leftYardLocal: string | null
  /** 'gate' = the provider's own EXIT record, the event the Live Feed narrates;
   *  'telemetry' = derived from the first fix beyond the yard radius. */
  leftYardSource: 'gate' | 'telemetry' | null
  /** Hours between the dispatch clock and leaving, when both are known. */
  yardWaitHours: number | null
  destination: string | null
  leg: string | null
  dueBackAt: string | null
  dueBackLocal: string | null
  dueBackSource: 'provider' | 'history' | null
  /**
   * Today's most recent CLOSED run, when nothing is open now. Kept in its own
   * three fields rather than reusing `destination`/`dispatchedAtLocal`, because
   * those carry an implicit "it is out there" that a finished run must not
   * inherit — a unit back in the yard at 09:05 is not "due back 15:20".
   */
  lastRunDestination: string | null
  lastRunDispatchedAtLocal: string | null
  lastRunReturnedAtLocal: string | null
  /**
   * How many runs this unit has been given today, cancellations excluded, and
   * how many of them are closed. `runIndex` is which of them is open right now
   * — 2 when the vehicle is on its second run — and is null when nothing is.
   *
   * Counted because "it is out on a job" is the same sentence for a tractor on
   * its first run of the morning and one on its third, and those are different
   * days. Measured 2026-08-17: 155 vehicles dispatched, 8 of them more than
   * once, so this is a fact about a minority — which is exactly why it is worth
   * saying when it is true and worth omitting when it is not. A brief that
   * announced "1st run today" on all 147 others would be noise in 95% of cases.
   *
   * CANCELLED dispatches are not runs and are excluded everywhere here. The
   * provider raises and voids them — KTCC 763G had one on 16 Aug — and counting
   * them would credit a vehicle with work it never did.
   */
  runsToday: number
  runsCompletedToday: number
  runIndex: number | null
  /** Where its EARLIER runs today went, oldest first, excluding the open one.
   *  Empty on a unit with a single run, which is most of them. */
  earlierRunDestinations: string[]
  speedKmh: number | null
  fuelLevelPct: number | null
  online: boolean | null
  lastReportedLocal: string | null
}

interface Entry { at: number; brief: VehicleBrief }
const cache = new Map<string, Entry>()
const generating = new Map<string, Promise<VehicleBrief>>()
/** Last time the model was asked about a vehicle, so re-measuring a moving unit
 *  cannot turn into a completion per page view. See getVehicleBrief. */
const lastModelAsk = new Map<string, number>()

function remember(key: string, brief: VehicleBrief): void {
  if (cache.size >= CACHE_MAX) {
    let oldest: string | null = null, oldestAt = Infinity
    for (const [k, e] of cache) if (e.at < oldestAt) { oldestAt = e.at; oldest = k }
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), brief })
}

// ── facts ───────────────────────────────────────────────────────────────────

/**
 * The day's distance and first movement.
 *
 * Deliberately NOT its own query. This module used to carry a hand-copied twin
 * of `coveredSince`, and the twin bound its lower bound as a driver parameter
 * where the original writes a naive-UTC TIMESTAMP literal — `captured_at` is
 * `timestamp without time zone` holding UTC, so the two windows agree only on a
 * UTC session and diverge by the session offset anywhere else. One query, one
 * window, one number, and no second definition to keep in step.
 */
async function movementToday(vehicleId: string, since: Date) {
  const byVehicle = await coveredSince([{ vehicleId, since }])
  const r = byVehicle.get(vehicleId)
  return {
    coveredM:      r?.coveredM ?? null,
    firstMovingAt: r?.firstMovingAt ?? null,
    fixes:         r?.fixCount ?? 0,
  }
}

async function collectFacts(orgId: string, vehicleId: string): Promise<VehicleFacts | null> {
  const dayStart = fleetDayStart()

  const [snapshot, trips, vehicle, fills, movement] = await Promise.all([
    getFleetSnapshot(orgId),
    getOpenTripsCached(orgId),
    prisma.vehicle.findFirst({
      where:  { id: vehicleId, organisationId: orgId },
      select: { registrationPlate: true, name: true },
    }),
    prisma.fuelFilling.findMany({
      // Deliveries that never arrived are excluded — see NO_FUEL_ARRIVED.
      where:   { vehicleId, filledAt: { gte: dayStart }, verdict: { notIn: NO_FUEL_ARRIVED } },
      orderBy: { filledAt: 'asc' },
      select:  { filledMl: true, location: true, filledAt: true },
    }),
    movementToday(vehicleId, dayStart),
  ])
  if (!vehicle) return null

  const row  = Array.isArray(snapshot) ? snapshot.find(v => v.vehicleId === vehicleId) : undefined
  const trip = trips.byVehicle.get(vehicleId) ?? null
  // The trip AS THE CARD RENDERS IT — the snapshot's decorated copy, which has
  // already decided whether this dispatch is a current run and carries the
  // figures the operator is looking at.
  const tripRow = (row as { trip?: { leg?: string; distanceTodayKm?: number | null } | null } | undefined)?.trip ?? null

  const dispatchedAt = trip ? new Date(trip.dispatchedAt) : null

  // EVERY run this vehicle was given today, not just the last one.
  //
  // This used to be a `findFirst` for the most recent dispatch, asked only when
  // nothing was open. It answered the question the brief was getting wrong —
  // who drove this vehicle today, since the dispatch is the only thing naming a
  // driver for 502 of the 597 vehicles — but it could not tell a unit on its
  // first run from one on its third, and the brief read identically either way.
  //
  // Asked unconditionally now, because the count is worth having whether or not
  // something is open, and it is one indexed read on (vehicle_id, dispatched_at)
  // for a single vehicle on a single day. That is cheaper than the two queries
  // this replaces in the common case.
  const dayRuns = await prisma.dispatch.findMany({
    where: {
      organisationId: orgId,
      vehicleId,
      dispatchedAt:   { gte: dayStart },
      // A cancelled dispatch is not a run. The provider raises and voids them,
      // and both counting one and narrating one as "it ran to X today, no
      // return time recorded" credit the vehicle with work it never did.
      status: { not: 'CANCELLED' },
    },
    orderBy: { dispatchedAt: 'asc' },
    select:  { driverName: true, destination: true, dispatchedAt: true, actualReturnAt: true },
  })

  // The one that is open, by its dispatch clock — the same instant the snapshot
  // built `trip` from. Falls back to the last run of the day, which is what an
  // open dispatch always is, so a clock that does not match to the millisecond
  // still yields the right ordinal rather than a null.
  const runIndex = trip
    ? (dayRuns.findIndex(r => r.dispatchedAt.getTime() === dispatchedAt?.getTime()) + 1 || dayRuns.length) || null
    : null

  const lastRun = trip ? null : (dayRuns[dayRuns.length - 1] ?? null)

  // Whichever came first: the wheels turning, or the paperwork. A unit can be
  // dispatched hours before it leaves, and it can also be working since dawn
  // with no dispatch raised at all. A closed run's clock counts here too — the
  // vehicle was working from it either way.
  const clockedOnAt  = dispatchedAt ?? lastRun?.dispatchedAt ?? null
  const firstMoving  = movement.firstMovingAt
  let startedAt: Date | null = null
  let startedSource: VehicleFacts['startedSource'] = null
  if (firstMoving && (!clockedOnAt || firstMoving < clockedOnAt)) {
    startedAt = firstMoving; startedSource = 'first-movement'
  } else if (clockedOnAt) {
    startedAt = clockedOnAt; startedSource = 'dispatch'
  } else if (firstMoving) {
    startedAt = firstMoving; startedSource = 'first-movement'
  }

  const refuelledMl = fills.reduce((s, f) => s + f.filledMl, 0)
  const capturedAt  = (row as { capturedAt?: string | null } | undefined)?.capturedAt ?? null

  // When it actually LEFT, as opposed to when the run was raised.
  //
  // The provider's own gate record first. It records an EXIT crossing and the
  // Live Feed already narrates it — "KTCB 474R · ISAAC KIPLANGAT NGENO left the
  // yard to KANYALGANDA" — so taking the same event means the brief and the
  // feed cannot put the same departure at two different times, which is the
  // whole complaint that started this. Matched on vehicle OR plate because the
  // movement handler publishes a plate and does not always resolve the cuid.
  //
  // Telemetry second, and only once the trip geometry agrees the unit has in
  // fact left: while the leg is 'at-yard' the first fix outside the radius
  // would be a piece of GPS scatter, and on 'no-fix' there is nothing to
  // measure at all.
  //
  // Costs at most two queries, and only for a vehicle that is out — the brief
  // is generated on demand for a unit somebody clicked, then cached.
  let leftYardAt: Date | null = null
  let leftYardSource: VehicleFacts['leftYardSource'] = null
  if (dispatchedAt) {
    const gate = await prisma.notification.findFirst({
      where: {
        organisationId: orgId,
        alertType:      'MOVEMENT_EXIT',
        occurredAt:     { gte: dispatchedAt },
        OR: [{ vehicleId }, { plate: vehicle.registrationPlate }],
      },
      orderBy: { occurredAt: 'asc' },
      select:  { occurredAt: true },
    })
    if (gate) {
      leftYardAt = gate.occurredAt
      leftYardSource = 'gate'
    } else if (trips.yard && tripRow?.leg && LEGS_CLEAR_OF_YARD.has(tripRow.leg)) {
      leftYardAt = await firstFixClearOfYard(vehicleId, dispatchedAt, trips.yard)
      if (leftYardAt) leftYardSource = 'telemetry'
    }
  }

  // Open dispatch, then standing assignment, then TODAY'S CLOSED RUN. The
  // snapshot already decides between the first two; the third is this module's,
  // and it is the difference between naming the person who drove the vehicle
  // this morning and telling the operator we have no idea who it was.
  const snapDriver = (row as { driver?: string | null } | undefined)?.driver ?? trip?.driverName ?? null
  const driver = snapDriver ?? lastRun?.driverName ?? null
  const driverSource: VehicleFacts['driverSource'] = snapDriver
    ? ((row as { driverSource?: VehicleFacts['driverSource'] } | undefined)?.driverSource ?? null)
    : (lastRun?.driverName ? 'last-dispatch' : null)

  return {
    plate:        vehicle.registrationPlate,
    driver,
    driverSource,
    // Dated when it is not today's clock — see localStamp.
    startedAt: startedAt ? localStamp(startedAt, dayStart) : null,
    startedSource,
    // The SAME number the Active Trip card shows, taken from the same object
    // whenever the vehicle is on a trip.
    //
    // Both sides compute ground covered since local midnight with the same
    // haversine and the same jitter floor, so they should agree anyway — but
    // "should agree" is how a card reading 27.8 km ends up beside a brief
    // reading 0.2 km. Reading the trip's own field makes them the same value,
    // not two values that ought to match. Vehicles with no open trip fall back
    // to this brief's own measurement, which is the only source for them.
    //
    // Null, not 0, when nothing was heard: "we have no fixes today" and "it
    // has not moved" are different facts and must not read the same.
    distanceTodayKm: tripRow?.distanceTodayKm
      ?? (movement.fixes > 1 && movement.coveredM != null
            ? Math.round(movement.coveredM / 100) / 10
            : null),
    refuelledLitres: fills.length ? Math.round(refuelledMl / 100) / 10 : null,
    refuelCount:     fills.length,
    // Shortened before they ever reach the card OR the model. The provider
    // records a full administrative address — "Ndhiwa-Uriri Rd., Kenya,
    // Kanyikela Ward, Ndhiwa Sub County, Homa Bay County, Riat Centre" — and a
    // two-sentence brief cannot spend a line and a half saying where Kenya is.
    // De-duped AFTER shortening, because two addresses in the same ward
    // collapse to the same label.
    refuelLocations: [...new Set(
      fills.map(f => shortPlaceLabel(f.location)).filter(Boolean) as string[],
    )],
    dispatchStatus:    trip?.status ?? null,
    dispatchedAtLocal: dispatchedAt ? localStamp(dispatchedAt, dayStart) : null,
    leftYardLocal:     leftYardAt ? localStamp(leftYardAt, dayStart) : null,
    leftYardSource,
    // How long it stood after the paperwork. Only quoted when both ends are
    // measured AND the gap survives rounding to a tenth of an hour: the gate
    // often fires within a minute of the dispatch being raised, and "it left
    // the yard at 04:45, 0 h after being dispatched" is a sentence that spends
    // eight words to say nothing. Negative is not a wait either — it means the
    // unit was already out when the run was raised.
    yardWaitHours: (() => {
      if (!dispatchedAt || !leftYardAt || leftYardAt <= dispatchedAt) return null
      const h = Math.round((leftYardAt.getTime() - dispatchedAt.getTime()) / 360_000) / 10
      return h >= 0.1 ? h : null
    })(),
    destination:   trip?.destination ?? null,
    // The leg comes off the SNAPSHOT's trip, not the raw dispatch: it is the
    // geometry decision (has it left, has it arrived, is it coming back) and
    // that is made once, in getFleetSnapshot, against the vehicle's position.
    // Absent when the snapshot has decided this dispatch is not a current run.
    leg: tripRow?.leg ?? null,
    dueBackAt:     trip?.dueBackAt ?? null,
    dueBackLocal:  trip?.dueBackAt ? clockFmt.format(new Date(trip.dueBackAt)) : null,
    dueBackSource: trip?.dueBackSource ?? null,
    lastRunDestination:       lastRun?.destination ?? null,
    lastRunDispatchedAtLocal: lastRun ? localStamp(lastRun.dispatchedAt, dayStart) : null,
    // Only when the provider actually closed it. A dispatch that is neither
    // open nor returned is paperwork in an unknown state, and saying "back at
    // —" would be worse than saying nothing.
    lastRunReturnedAtLocal:   lastRun?.actualReturnAt ? localStamp(lastRun.actualReturnAt, dayStart) : null,
    runsToday:          dayRuns.length,
    runsCompletedToday: dayRuns.filter(r => r.actualReturnAt != null).length,
    runIndex,
    // Every run but the one being described, so the brief can say where the day
    // has already taken it without repeating the destination it is heading to.
    earlierRunDestinations: dayRuns
      .slice(0, runIndex != null ? runIndex - 1 : Math.max(dayRuns.length - 1, 0))
      .map(r => r.destination)
      .filter((d): d is string => Boolean(d)),
    speedKmh:      (row as { speedKmh?: number | null } | undefined)?.speedKmh ?? null,
    fuelLevelPct:  (row as { fuelLevelPct?: number | null } | undefined)?.fuelLevelPct ?? null,
    online:        (row as { connectionOnline?: boolean | null } | undefined)?.connectionOnline ?? null,
    lastReportedLocal: capturedAt ? clockFmt.format(new Date(capturedAt)) : null,
  }
}

// ── the sentence ────────────────────────────────────────────────────────────

/**
 * How each leg reads in a sentence. Undefined means the leg is DELIBERATELY not
 * narrated and the brief simply omits it.
 *
 * 'outbound' has no phrase. It used to read "is on its way out", which the
 * operator asked to be removed: it is the weakest claim the geometry makes —
 * only that the unit is somewhere past the yard radius and not yet at its
 * destination — and it adds nothing to a sentence that has already said where
 * the vehicle was sent, when it left and when it is due. The stronger legs
 * ('at-destination', 'returning', 'back') each say something the reader cannot
 * work out from the dispatch alone, so they stay.
 */
const LEG_PHRASE: Record<string, string | undefined> = {
  'no-fix':         'has not reported since it was dispatched',
  'at-yard':        'is still at the yard',
  'at-destination': 'is at the destination',
  'returning':      'is on its way back',
  'back':           'is back at the yard',
}

/**
 * The same brief, written from the facts alone.
 *
 * Deliberately plain. This is the floor the feature stands on — no API key, a
 * timeout, a malformed reply — and an operator gets the same information
 * either way. Sentences are only emitted for figures that exist, so an absent
 * fact leaves a shorter brief rather than a zero.
 */
/** 1st, 2nd, 3rd, 4th — for the run ordinal, which never gets large. */
function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

export function buildFallback(f: VehicleFacts): string {
  const parts: string[] = []

  // Past tense for a run that has finished. "KTCC 832B is with PETER OUMA
  // ODIEGI" is a claim about right now, and the vehicle has been parked in the
  // yard since 09:05 — the name is still the answer to "who drove it today",
  // which is what the brief is for, but the tense has to say so.
  const who = f.driver
    ? (f.driverSource === 'last-dispatch'
        ? `${f.plate} was with ${f.driver} on today's run`
        : `${f.plate} is with ${f.driver}${f.driverSource === 'dispatch' ? ' on today\'s dispatch' : ''}`)
    : `${f.plate} has no driver on record`
  parts.push(f.startedAt ? `${who}, since ${f.startedAt}.` : `${who}.`)

  const did: string[] = []
  if (f.distanceTodayKm != null) did.push(`covered ${f.distanceTodayKm} km today`)
  if (f.refuelledLitres != null) {
    did.push(`took on ${f.refuelledLitres} L${f.refuelLocations.length ? ` at ${f.refuelLocations[0]}` : ''}`)
  }
  if (did.length) parts.push(`It has ${did.join(' and ')}.`)

  // The run. "Dispatched" leads when we have the clock: "Sent to OPAPO" is a
  // standing fact about the vehicle, while "Dispatched 06:10 to OPAPO" is the
  // one an operator reconstructing the day is actually asking for.
  const onARun = Boolean(f.destination || f.dispatchedAtLocal)
  if (onARun) {
    const overdue = f.dispatchStatus === 'OVERDUE' ? ' (overdue)' : ''
    const where   = f.destination ?? 'a destination the dispatcher did not record'
    const head    = f.dispatchedAtLocal
      ? `Dispatched ${f.dispatchedAtLocal} to ${where}${overdue}`
      : `Sent to ${where}${overdue}`
    const leg = f.leg ? LEG_PHRASE[f.leg] : null
    parts.push(leg
      ? `${head} and ${leg}${f.dueBackLocal ? `; due back ${f.dueBackLocal}` : ''}.`
      : `${head}${f.dueBackLocal ? `, due back ${f.dueBackLocal}` : ''}.`)

    // Which run of the day this is — only once there has been more than one.
    // On a single-run vehicle "its 1st run today" is four words that tell the
    // operator what the previous sentence already did, and that is 147 of the
    // 155 units dispatched on the day this was measured.
    if (f.runIndex != null && f.runsToday > 1) {
      // Shuttling to the same place is the normal shape of a second run here —
      // OPAPO twice, PALA PRIMARY twice, ONGITO SHILINGI twice on the day this
      // was measured — and "Dispatched to PALA PRIMARY… after PALA PRIMARY"
      // names it twice in one breath. When every earlier run went where this
      // one is going, "there" carries it.
      const others   = [...new Set(f.earlierRunDestinations.filter(d => d !== f.destination))]
      const shuttling = f.earlierRunDestinations.length > 0 && others.length === 0
      parts.push(shuttling
        ? `That is its ${ordinal(f.runIndex)} run there today.`
        : `That is its ${ordinal(f.runIndex)} run today${others.length ? `, after ${others.join(' and ')}` : ''}.`)
    }

    // Leaving is a separate event from being dispatched, and on this fleet the
    // gap between them is the thing worth knowing — a quarter of the units
    // carrying an open dispatch are still standing in the yard.
    if (f.leftYardLocal) {
      parts.push(f.yardWaitHours != null
        ? `It left the yard at ${f.leftYardLocal}, ${f.yardWaitHours} h after being dispatched.`
        : `It left the yard at ${f.leftYardLocal}.`)
    }
  } else if (f.lastRunDestination || f.lastRunReturnedAtLocal) {
    // Nothing open, but it did work today. "No dispatch open" was technically
    // true and read as "this unit has done nothing", which for a tractor that
    // ran to OGANDO CENTRAL and came back at 09:05 is the opposite of the truth.
    const where = f.lastRunDestination ? ` to ${f.lastRunDestination}` : ''
    const out   = f.lastRunDispatchedAtLocal ? `, out ${f.lastRunDispatchedAtLocal}` : ''
    // "It ran to X" is the whole day for a unit with one run and only the last
    // leg of it for a unit with three, so the count leads once there is one.
    const runs  = f.runsToday > 1
      ? `It made ${f.runsToday} runs today, the last${where}${out}`
      : `It ran${where} today${out}`
    parts.push(f.lastRunReturnedAtLocal
      ? `${runs}, and was back at ${f.lastRunReturnedAtLocal}. Nothing open now.`
      : `${runs}, closed on the provider's books with no return time recorded.`)
  } else if (f.lastReportedLocal) {
    parts.push(`No dispatch open; last reported ${f.lastReportedLocal}.`)
  }

  return parts.join(' ')
}

const SYSTEM_PROMPT =
  'You brief the duty operator of a Kenyan haulage fleet on ONE vehicle. You receive a JSON object of ' +
  'MEASURED facts about that vehicle today. Write 3-4 short sentences, at most 75 words, in this shape: ' +
  'which vehicle and who is driving it and since when, what the vehicle has done today (distance covered, ' +
  'fuel taken on), the dispatch it is on — when it was dispatched (dispatchedAtLocal), where to, and when it ' +
  'actually left the yard (leftYardLocal, with yardWaitHours as the gap between the two) — and when it is due ' +
  'back at base. ' +
  'NAME THE VEHICLE AND THE DRIVER. Open with the `plate`, and whenever `driver` is a name, write that name out ' +
  'in full and EXACTLY as spelled in the JSON — never re-spell it, shorten it, or replace it with a description. ' +
  'Never call a fact unreported when the JSON contains it. ' +
  'SAY WHICH RUN OF THE DAY THIS IS. When runsToday is 2 or more, state the number — "its 2nd run today", ' +
  '"it has made 3 runs today" — using runIndex for the one that is open and runsToday for the total, and name ' +
  'the earlier destinations from earlierRunDestinations when they differ from the destination it is on now — ' +
  'when they are the SAME place the unit is shuttling, so write "its 2nd run there today" and do not name that ' +
  'place twice in one brief. When runsToday is 1 or 0, say ' +
  'NOTHING about the count at all: do not write "its first run", "its only run" or "one run today". ' +
  'NEVER say the vehicle is "on its way out", "outbound", "heading out" or "en route out", and never describe ' +
  'it as having left and not yet arrived. The `leg` field may contain "outbound"; that value must not be ' +
  'narrated in any wording. The other legs may be: at the yard, at the destination, on its way back, back at ' +
  'the yard. ' +
  'When driverSource is "last-dispatch" the run has already finished, so write about the driver and the run in ' +
  'the PAST tense: that person drove it today, and it is back. In that case there is no destination, leg or due ' +
  'back — use lastRunDestination, lastRunDispatchedAtLocal and lastRunReturnedAtLocal instead, and do not imply ' +
  'the vehicle is still out. ' +
  'A null means the fleet does not know that fact: SAY NOTHING ABOUT IT AT ALL. Do not write "not reported", ' +
  '"no data", "unknown", "not recorded" or any other phrase announcing an absence — a shorter brief is the ' +
  'correct output, and an operator reading a list of things we failed to measure learns nothing. ' +
  'CRITICAL: use ONLY numbers present in the JSON. Never estimate, extrapolate, round differently, or invent a ' +
  'figure that is not there. In particular quote distanceTodayKm EXACTLY as given; it is the same figure the ' +
  'operator sees on the vehicle card and the two must match to the decimal. Place names in refuelLocations are ' +
  'already shortened — use them verbatim and do not expand them. Do not add advice, praise, or speculation ' +
  'about causes. Write complete declarative sentences, not a list of labelled fields; no markdown, no preamble, ' +
  'no bullet points. If dueBackSource is "history", say the return time is estimated from past runs. ' +
  'Reply with STRICT JSON: {"msg": string}.'

/** Phrases that announce an absence. The brief must omit what it does not know,
 *  not narrate it — see the prompt. */
const ABSENCE_PHRASE = /\b(not (reported|recorded|available|known|provided)|no data|unknown|unreported|n\/?a)\b/i

/**
 * The outbound claim, which the operator asked not to be made.
 *
 * Enforced here and not only in the prompt, for the reason the whole validator
 * exists: the prompt is a request. This module has already watched the model
 * ignore an instruction it was given in capitals, and a banned phrase that
 * survives into production is worse than a rejected reply — the fallback
 * sentence no longer contains it at all, so falling back is a strictly correct
 * outcome.
 */
const OUTBOUND_PHRASE = /\b(on (its|the) way out|out(-|\s)?bound|heading out|en route out|on its way there)\b/i

/**
 * Is the model's sentence a faithful rendering of the facts it was given?
 *
 * The contract of this module is that the model buys PHRASING, not information.
 * A brief that drops a fact we measured, or announces one we did not, has broken
 * that contract and is worse than the deterministic sentence — an operator who
 * reads "driver not reported" beside a card showing the driver's name stops
 * trusting both. There is already a complete answer to fall back to, so the bar
 * for accepting the model's version is that it lost nothing.
 *
 * Checks what is cheap and unambiguous: the driver's name and the day's
 * distance must appear when we know them, and no absence phrase may appear at
 * all. Returns the reason it failed, or null when it passed, so the rejection
 * is diagnosable in the log rather than silent.
 */
export function modelBriefRejectionReason(msg: string, f: VehicleFacts): string | null {
  const absence = msg.match(ABSENCE_PHRASE)
  if (absence) return `narrates an absence ("${absence[0]}")`

  const outbound = msg.match(OUTBOUND_PHRASE)
  if (outbound) return `states the vehicle is outbound ("${outbound[0]}")`

  // Matched case-insensitively on the whole name. The provider writes these in
  // upper case and a model reasonably renders them in title case.
  if (f.driver && !msg.toLowerCase().includes(f.driver.toLowerCase())) {
    return 'omits the driver we know'
  }

  // The figure that must agree with the vehicle card, to the decimal.
  if (f.distanceTodayKm != null) {
    const shown = String(f.distanceTodayKm)
    // Bounded so "0.1" does not match inside "10.1", and "32" does not match
    // inside "32.4" — the near-miss is exactly the failure worth catching.
    if (!new RegExp(`(^|[^\\d.])${shown.replace('.', '\\.')}([^\\d.]|$)`).test(msg)) {
      return `does not quote distanceTodayKm (${shown})`
    }
  }

  return null
}

async function askModel(facts: VehicleFacts): Promise<VehicleBrief> {
  const fallback = (): VehicleBrief => ({
    msg: buildFallback(facts), source: 'facts', generatedAt: new Date().toISOString(), facts,
  })
  if (!env.OPENAI_API_KEY) return fallback()

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: JSON.stringify(facts) },
        ],
        response_format: { type: 'json_object' },
      }),
      // Generous, because this no longer blocks anybody: the operator already
      // has the facts brief. Measured on the box, gpt-5-nano did not answer
      // inside 12 s, so a short timeout meant the model version never landed
      // at all while still costing the request twelve seconds.
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body   = await res.json() as { choices?: { message?: { content?: string } }[] }
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { msg?: string }
    if (!parsed.msg) throw new Error('empty brief from model')

    // Accepted only if it kept every fact it was given. A prompt is a request,
    // not a guarantee: measured in production, the model returned "Driver
    // FREDRICK OCHIENG ONGOLA since 07:45. Distance today: 0.1 km; fuel data
    // not reported… yard wait hours not reported" — a field dump that spent
    // half its words on things nobody measured. The deterministic sentence is
    // strictly better than that, and it is already written.
    const reason = modelBriefRejectionReason(parsed.msg, facts)
    if (reason) {
      logger.warn(
        { plate: facts.plate, reason, msg: parsed.msg },
        'Vehicle brief: model reply rejected — the facts-only brief stands',
      )
      return fallback()
    }

    return { msg: parsed.msg, source: 'model', generatedAt: new Date().toISOString(), facts }
  } catch (err) {
    logger.warn({ err, plate: facts.plate }, 'Vehicle brief: model failed — the facts-only brief stands')
    return fallback()
  }
}

/**
 * One vehicle's brief.
 *
 * The MODEL IS NEVER ON THE REQUEST PATH. The facts are gathered, the
 * deterministic brief is written from them and returned immediately, and the
 * model is asked in the background; when it answers it replaces the cache
 * entry, so the next read of the same vehicle gets the phrased version.
 *
 * That ordering is not a nicety. Measured on the box, gpt-5-nano did not
 * answer inside twelve seconds — as a blocking call that is an operator
 * staring at a spinner after clicking a truck, and with a short timeout they
 * would wait the twelve seconds and STILL get the fallback. Answering from
 * facts first makes the model a free upgrade: if it lands, the wording
 * improves; if it never does, nobody waited for it.
 *
 * Cached for CACHE_TTL_MS, and concurrent callers for one vehicle share a
 * single generation rather than each firing a completion — but the cache is
 * ALSO dropped early whenever the day's distance has moved on underneath it,
 * because that figure is printed twice on the same screen (here and on the
 * Active Trip card, which refreshes every sweep) and a ten-minute-old brief
 * quoting 0.4 km beside a card reading 3.1 km is the operator's problem.
 * Re-measuring does not re-ask the model — see lastModelAsk — so a unit driving
 * all afternoon costs the same completions as one standing still.
 */
export async function getVehicleBrief(orgId: string, vehicleId: string): Promise<VehicleBrief> {
  const key = `${orgId}:${vehicleId}`

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS && await distanceStillAgrees(orgId, vehicleId, hit.brief)) {
    return hit.brief
  }

  const inflight = generating.get(key)
  if (inflight) return inflight

  const p = (async () => {
    const facts = await collectFacts(orgId, vehicleId)
    if (!facts) throw new Error('vehicle not found')

    const immediate: VehicleBrief = {
      msg: buildFallback(facts), source: 'facts', generatedAt: new Date().toISOString(), facts,
    }
    remember(key, immediate)

    // Detached. A failure here is logged inside askModel and leaves the facts
    // brief in place, which is a complete answer in its own right.
    //
    // Rate-limited independently of the cache. A moving vehicle now
    // re-measures on every view (the distance check above), and without this
    // gate each of those would buy a completion for a sentence that differs
    // from the last one by a decimal point.
    const askedAt = lastModelAsk.get(key) ?? 0
    if (env.OPENAI_API_KEY && Date.now() - askedAt >= CACHE_TTL_MS) {
      lastModelAsk.set(key, Date.now())
      void askModel(facts)
        .then((brief) => { if (brief.source === 'model') remember(key, brief) })
        .catch(() => { /* askModel already fell back and logged */ })
    }

    return immediate
  })().finally(() => { generating.delete(key) })

  generating.set(key, p)
  return p
}

/**
 * Does a cached brief still quote the distance the vehicle card is showing?
 *
 * Reads the warm open-trips cache — in memory, no query — and compares the
 * figure the Active Trip card is rendering right now against the one baked
 * into the cached sentence. `true` for a vehicle with no open trip: there is no
 * card figure to contradict, so the brief's own measurement stands until the
 * TTL expires.
 */
async function distanceStillAgrees(
  orgId: string, vehicleId: string, brief: VehicleBrief,
): Promise<boolean> {
  try {
    const { byVehicle } = await getOpenTripsCached(orgId)
    const open = byVehicle.get(vehicleId)
    if (!open || open.distanceTodayM == null) return true
    // Same conversion buildTrip applies, so this compares the rendered value
    // rather than one derived a second way.
    const live = Math.round(open.distanceTodayM / 100) / 10
    return brief.facts.distanceTodayKm === live
  } catch {
    // The cache is unavailable — serve what we have rather than hammering the
    // database to prove a figure we cannot currently read.
    return true
  }
}
