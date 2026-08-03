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
import { prisma } from '../../lib/prisma.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import { getOpenTripsCached } from '../dispatches/open-trips.cache.js'
// The DECORATED snapshot, not fleet-snapshot.cache's raw rows. `driverSource`
// and `trip` are attached by this service, not by the cached query — reading
// the cache directly left both undefined, so every brief reported a null leg
// and could not tell a dispatch driver from a standing assignment.
import { getFleetSnapshot } from '../telemetry/telemetry.service.js'

/** How long one vehicle's brief stays fresh. */
const CACHE_TTL_MS = 10 * 60_000

/** Bounded, so browsing a 597-vehicle fleet cannot grow this without limit. */
const CACHE_MAX = 300

/** Fixes closer together than this are GPS jitter, not travel — same floor the
 *  dispatch distance and the track endpoint use. */
const MIN_SPACING_M = 15

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

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
  /** 'dispatch' = the person on today's run; 'assignment' = the standing link. */
  driverSource: 'dispatch' | 'assignment' | null
  /** Local HH:MM of the first movement today, or of the dispatch if earlier. */
  startedAt: string | null
  startedSource: 'first-movement' | 'dispatch' | null
  /** Ground covered today through the vehicle's own fixes. */
  distanceTodayKm: number | null
  /** Fuel put in today. */
  refuelledLitres: number | null
  refuelCount: number
  refuelLocations: string[]
  destination: string | null
  leg: string | null
  dueBackAt: string | null
  dueBackLocal: string | null
  dueBackSource: 'provider' | 'history' | null
  speedKmh: number | null
  fuelLevelPct: number | null
  online: boolean | null
  lastReportedLocal: string | null
}

interface Entry { at: number; brief: VehicleBrief }
const cache = new Map<string, Entry>()
const generating = new Map<string, Promise<VehicleBrief>>()

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
 * The day's distance and first movement, in one query.
 *
 * Ground covered through the real fixes since local midnight, hops under
 * MIN_SPACING_M dropped — a parked unit's GPS jitter would otherwise
 * accumulate kilometres of "travel" while it stood still, and this number is
 * about to be read out to an operator as fact.
 */
async function movementToday(vehicleId: string, since: Date) {
  const rows = await prisma.$queryRaw<{
    covered_m: number | null; first_moving_at: Date | null; fixes: bigint
  }[]>`
    WITH fixes AS (
      SELECT captured_at, speed_kmh, lat, lng,
             LAG(lat) OVER w AS prev_lat,
             LAG(lng) OVER w AS prev_lng
        FROM vehicle_telemetries
       WHERE vehicle_id = ${vehicleId}
         AND captured_at >= ${since}
         AND lat IS NOT NULL AND lng IS NOT NULL
      WINDOW w AS (ORDER BY captured_at)
    ),
    hops AS (
      SELECT captured_at, speed_kmh,
             CASE WHEN prev_lat IS NULL THEN 0 ELSE
               2 * 6371000 * asin(sqrt(
                 power(sin(radians(lat - prev_lat) / 2), 2) +
                 cos(radians(prev_lat)) * cos(radians(lat)) *
                 power(sin(radians(lng - prev_lng) / 2), 2)
               ))
             END AS hop_m
        FROM fixes
    )
    SELECT COALESCE(SUM(CASE WHEN hop_m >= ${MIN_SPACING_M} THEN hop_m ELSE 0 END), 0) AS covered_m,
           MIN(captured_at) FILTER (WHERE speed_kmh > 0) AS first_moving_at,
           COUNT(*) AS fixes
      FROM hops
  `
  const r = rows[0]
  return {
    coveredM:      r?.covered_m != null ? Number(r.covered_m) : null,
    firstMovingAt: r?.first_moving_at ?? null,
    fixes:         Number(r?.fixes ?? 0),
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
      where:   { vehicleId, filledAt: { gte: dayStart } },
      orderBy: { filledAt: 'asc' },
      select:  { filledMl: true, location: true, filledAt: true },
    }),
    movementToday(vehicleId, dayStart),
  ])
  if (!vehicle) return null

  const row  = Array.isArray(snapshot) ? snapshot.find(v => v.vehicleId === vehicleId) : undefined
  const trip = trips.byVehicle.get(vehicleId) ?? null

  // Whichever came first: the wheels turning, or the paperwork. A unit can be
  // dispatched hours before it leaves, and it can also be working since dawn
  // with no dispatch raised at all.
  const dispatchedAt = trip ? new Date(trip.dispatchedAt) : null
  const firstMoving  = movement.firstMovingAt
  let startedAt: Date | null = null
  let startedSource: VehicleFacts['startedSource'] = null
  if (firstMoving && (!dispatchedAt || firstMoving < dispatchedAt)) {
    startedAt = firstMoving; startedSource = 'first-movement'
  } else if (dispatchedAt) {
    startedAt = dispatchedAt; startedSource = 'dispatch'
  } else if (firstMoving) {
    startedAt = firstMoving; startedSource = 'first-movement'
  }

  const refuelledMl = fills.reduce((s, f) => s + f.filledMl, 0)
  const capturedAt  = (row as { capturedAt?: string | null } | undefined)?.capturedAt ?? null

  return {
    plate:        vehicle.registrationPlate,
    driver:       (row as { driver?: string | null } | undefined)?.driver ?? trip?.driverName ?? null,
    driverSource: (row as { driverSource?: VehicleFacts['driverSource'] } | undefined)?.driverSource ?? null,
    // Marked when it is not today's clock. A run that crossed local midnight
    // is common here (the median round trip is about nineteen hours), and a
    // bare "since 20:56" read at 05:20 says the opposite of what it means.
    startedAt: startedAt
      ? clockFmt.format(startedAt) + (startedAt < dayStart ? ' yesterday' : '')
      : null,
    startedSource,
    // Null, not 0, when nothing was heard: "we have no fixes today" and "it has
    // not moved" are different facts and must not read the same.
    distanceTodayKm: movement.fixes > 1 && movement.coveredM != null
      ? Math.round(movement.coveredM / 100) / 10
      : null,
    refuelledLitres: fills.length ? Math.round(refuelledMl / 100) / 10 : null,
    refuelCount:     fills.length,
    refuelLocations: [...new Set(fills.map(f => f.location).filter(Boolean) as string[])],
    destination:   trip?.destination ?? null,
    // The leg comes off the SNAPSHOT's trip, not the raw dispatch: it is the
    // geometry decision (has it left, has it arrived, is it coming back) and
    // that is made once, in getFleetSnapshot, against the vehicle's position.
    // Absent when the snapshot has decided this dispatch is not a current run.
    leg: (row as { trip?: { leg?: string } | null } | undefined)?.trip?.leg ?? null,
    dueBackAt:     trip?.dueBackAt ?? null,
    dueBackLocal:  trip?.dueBackAt ? clockFmt.format(new Date(trip.dueBackAt)) : null,
    dueBackSource: trip?.dueBackSource ?? null,
    speedKmh:      (row as { speedKmh?: number | null } | undefined)?.speedKmh ?? null,
    fuelLevelPct:  (row as { fuelLevelPct?: number | null } | undefined)?.fuelLevelPct ?? null,
    online:        (row as { connectionOnline?: boolean | null } | undefined)?.connectionOnline ?? null,
    lastReportedLocal: capturedAt ? clockFmt.format(new Date(capturedAt)) : null,
  }
}

// ── the sentence ────────────────────────────────────────────────────────────

const LEG_PHRASE: Record<string, string> = {
  'no-fix':         'has not reported since it was dispatched',
  'at-yard':        'is still at the yard',
  'outbound':       'is on its way out',
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
export function buildFallback(f: VehicleFacts): string {
  const parts: string[] = []

  const who = f.driver
    ? `${f.plate} is with ${f.driver}${f.driverSource === 'dispatch' ? ' on today\'s dispatch' : ''}`
    : `${f.plate} has no driver on record`
  parts.push(f.startedAt ? `${who}, since ${f.startedAt}.` : `${who}.`)

  const did: string[] = []
  if (f.distanceTodayKm != null) did.push(`covered ${f.distanceTodayKm} km today`)
  if (f.refuelledLitres != null) {
    did.push(`took on ${f.refuelledLitres} L${f.refuelLocations.length ? ` at ${f.refuelLocations[0]}` : ''}`)
  }
  if (did.length) parts.push(`It has ${did.join(' and ')}.`)

  if (f.destination) {
    const leg = f.leg ? LEG_PHRASE[f.leg] : null
    parts.push(leg
      ? `Sent to ${f.destination} and ${leg}${f.dueBackLocal ? `; due back ${f.dueBackLocal}` : ''}.`
      : `Sent to ${f.destination}${f.dueBackLocal ? `, due back ${f.dueBackLocal}` : ''}.`)
  } else if (f.lastReportedLocal) {
    parts.push(`No dispatch open; last reported ${f.lastReportedLocal}.`)
  }

  return parts.join(' ')
}

const SYSTEM_PROMPT =
  'You brief the duty operator of a Kenyan haulage fleet on ONE vehicle. You receive a JSON object of ' +
  'MEASURED facts about that vehicle today. Write 2-3 short sentences, at most 55 words, in this shape: ' +
  'who is driving and since when, what the vehicle has done today (distance covered, fuel taken on), ' +
  'where it was sent and when it is due back at base. ' +
  'CRITICAL: use ONLY numbers present in the JSON. Never estimate, extrapolate, round differently, or invent a ' +
  'figure that is not there — a null means the fleet does not know it, so SAY nothing about it or say it is not ' +
  'reported. Do not add advice, praise, or speculation about causes. Plain declarative sentences, no markdown, ' +
  'no preamble, no bullet points. If dueBackSource is "history", say the return time is estimated from past runs. ' +
  'Reply with STRICT JSON: {"msg": string}.'

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
 * single generation rather than each firing a completion.
 */
export async function getVehicleBrief(orgId: string, vehicleId: string): Promise<VehicleBrief> {
  const key = `${orgId}:${vehicleId}`

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.brief

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
    if (env.OPENAI_API_KEY) {
      void askModel(facts)
        .then((brief) => { if (brief.source === 'model') remember(key, brief) })
        .catch(() => { /* askModel already fell back and logged */ })
    }

    return immediate
  })().finally(() => { generating.delete(key) })

  generating.set(key, p)
  return p
}
