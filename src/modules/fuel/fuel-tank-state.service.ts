/**
 * Per-vehicle tank state for the Fuel FSL table, for one fleet day.
 *
 * The rule is in `fuel-tank-state.ts` and is pure; this is the plumbing.
 *
 * Two queries for the whole org, never one per vehicle. A fleet of 200 units
 * would otherwise cost 400 round trips to the same pooler the 2-second
 * telemetry poll is using, for a table that redraws whenever an operator opens
 * a tab.
 */

import { prisma } from '../../lib/prisma.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import {
  closingLevel, deriveTankState, resolveEngineSeconds,
  MAX_ENGINE_GAP_SECONDS, MOTION_MIN_KMH, UNKNOWN_TANK_STATE,
  type LevelReading, type TankState,
} from './fuel-tank-state.js'
import { getOrgFuelRates } from './fuel-rate.service.js'

/**
 * Readings pulled per vehicle to reconstruct the previous day's close.
 *
 * MUST exceed the densest CLOSE_WINDOW_MINUTES any vehicle produces, or the
 * median is taken over a shorter span than `closingLevel` would use on the full
 * day and the reconciliation silently breaks for exactly the busiest units.
 *
 * Measured over two days of live telemetry, readings per 15 minutes:
 * p50 2, p99 77, **densest 376**. This was 60 first — above p99, and it still
 * broke two vehicles, which is how the ceiling got measured rather than
 * guessed. 600 clears the observed maximum with room for a burstier unit.
 *
 * Over-fetching is free: `closingLevel` applies the real time window to
 * whatever it is handed, so extra rows are discarded rather than counted.
 */
const PREV_CLOSE_SAMPLES = 600

/**
 * How far back to gather run slosh so the turbulence average can span days.
 *
 * Vehicles average 1.3-2.0 runs a day (measured 2026-08-13), so a fortnight
 * comfortably contains the TURBULENCE_STOPS most recent runs for all but the
 * most idle unit — and one that idle has no recent journeys to describe.
 */
const TREND_LOOKBACK_DAYS = 14

/**
 * Longest single hop counted as travel.
 *
 * At a 30-second ping, 10 km between consecutive fixes is over 600 km/h — a GPS
 * jump, not a journey. One such fix left in would add hundreds of kilometres to
 * a vehicle's day, and the dropped hop costs at most the real distance the unit
 * covered while its fix was wrong.
 */
const MAX_HOP_KM = 10

export interface VehicleTankState extends TankState {
  vehicleId: string
}

/**
 * Tank state for every vehicle in the org, for the fleet day containing `asOf`.
 *
 * `asOf` bounds the day: for today it is now, so `currentMl` is the latest
 * reading; for a past day the caller passes that day's end and `currentMl` is
 * that day's closing level.
 */
export async function getFleetTankState(orgId: string, asOf = new Date()): Promise<VehicleTankState[]> {
  const dayStart = fleetDayStart(asOf)

  // The day's readings, for the closing level and the working turbulence.
  const dayRows = await prisma.vehicleTelemetry.findMany({
    where: {
      vehicle:     { organisationId: orgId },
      capturedAt:  { gte: dayStart, lte: asOf },
      fuelLevelMl: { not: null },
    },
    select:  { vehicleId: true, capturedAt: true, fuelLevelMl: true, engineOn: true, speedKmh: true },
    orderBy: { capturedAt: 'asc' },
  })

  // The PREVIOUS day's closing level — the LAST FEW readings per vehicle, not
  // one, and not another 24 hours of rows either.
  //
  // It has to be the last few, because `closingLevel` medianises the final
  // CLOSE_WINDOW_MINUTES and this value must come out identical to the
  // `currentMl` that vehicle's own row showed yesterday. Otherwise one day's
  // Current and the next day's Initial disagree and the column stops
  // reconciling — which is the whole reason the pair is a day boundary. A
  // single reading, which is what this did first, cannot match a median.
  //
  // `PREV_CLOSE_SAMPLES` is a comfortable over-fetch of the ~30 readings
  // CLOSE_WINDOW_MINUTES spans at this fleet's ping rate; `closingLevel` then
  // applies the real time window to whatever it is handed, so over-fetching is
  // free and under-fetching would silently change the answer.
  //
  // LATERAL rather than a 24-hour scan: it walks the (vehicle_id, captured_at)
  // index backwards per vehicle and stops after LIMIT rows.
  const prevStart = new Date(dayStart.getTime() - 24 * 3_600_000)
  const prevRows = await prisma.$queryRaw<Array<{
    vehicle_id: string; captured_at: Date; fuel_level_ml: number
  }>>`
    SELECT v.id AS vehicle_id, t.captured_at, t.fuel_level_ml
      FROM vehicles v
      CROSS JOIN LATERAL (
        SELECT tt.captured_at, tt.fuel_level_ml
          FROM vehicle_telemetries tt
         WHERE tt.vehicle_id = v.id
           AND tt.captured_at >= ${prevStart}
           AND tt.captured_at <  ${dayStart}
           AND tt.fuel_level_ml IS NOT NULL
         ORDER BY tt.captured_at DESC
         LIMIT ${PREV_CLOSE_SAMPLES}
      ) t
     WHERE v.organisation_id = ${orgId}`

  const prevByVehicle = new Map<string, LevelReading[]>()
  for (const r of prevRows) {
    const s = { capturedAt: r.captured_at, fuelLevelMl: r.fuel_level_ml }
    const list = prevByVehicle.get(r.vehicle_id)
    if (list) list.push(s)
    else prevByVehicle.set(r.vehicle_id, [s])
  }
  const prevClose = new Map<string, number>()
  for (const [id, rows] of prevByVehicle) {
    // The LATERAL returns them newest-first; closingLevel expects ascending.
    rows.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
    const close = closingLevel(rows)
    if (close != null) prevClose.set(id, close)
  }

  const byVehicle = new Map<string, LevelReading[]>()
  for (const r of dayRows) {
    const s = {
      capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl!,
      engineOn: r.engineOn, speedKmh: r.speedKmh,
    }
    const list = byVehicle.get(r.vehicleId)
    if (list) list.push(s)
    else byVehicle.set(r.vehicleId, [s])
  }

  // Run slosh from BEFORE this day, so the turbulence average spans midnight
  // rather than restarting on it. Only the last TURBULENCE_STOPS runs can
  // matter, and vehicles average 1.3-2.0 runs a day, so a fortnight is a
  // generous reach — bounded so a long-silent vehicle cannot drag the query.
  const priorFrom = new Date(dayStart.getTime() - TREND_LOOKBACK_DAYS * 86_400_000)
  const priorRows = await prisma.fuelDailyTrend.findMany({
    where:   { day: { gte: priorFrom, lt: dayStart }, vehicle: { organisationId: orgId } },
    select:  { vehicleId: true, runSloshMl: true },
    orderBy: { day: 'asc' },
  })
  const priorRuns = new Map<string, number[]>()
  for (const r of priorRows) {
    const list = priorRuns.get(r.vehicleId)
    if (list) list.push(...r.runSloshMl)
    else priorRuns.set(r.vehicleId, [...r.runSloshMl])
  }

  // Ground covered today, and time the engine spent running — the two
  // measurements the day's fuel expectations are built on.
  //
  // ONE pass over the day's telemetry for both. They need the same rows: every
  // fix, including the ones with no fuel reading that the day query above
  // filters out. Pulling those into memory would roughly double the payload for
  // two numbers, and running two queries would scan the same partition twice.
  //
  // Distance: there is no odometer on vehicle_telemetries — Wialon's counter
  // reaches the snapshot but is not persisted per ping — so it is the sum of
  // great-circle hops between consecutive fixes. Haversine written out rather
  // than PostGIS: ST_DistanceSphere would do, but this needs no extension to be
  // present and the arithmetic is not the hard part. Hops longer than
  // MAX_HOP_KM are dropped — at a 30-second ping that is over 600 km/h, so it
  // is a GPS jump rather than travel, and one such fix would otherwise add
  // hundreds of kilometres to a vehicle's day.
  //
  // Engine seconds: the gap between consecutive fixes, charged to the EARLIER
  // fix's engine state and capped at MAX_ENGINE_GAP_SECONDS. The day's first
  // fix per vehicle has no predecessor, so `prev_on` and `secs` are both NULL
  // there and the CASE contributes nothing — a day opens from its first ping,
  // not from midnight, which is the only honest reading when the hours before
  // it are simply unobserved.
  //
  // The two are computed over DIFFERENT row sets on purpose: the hop chain
  // takes only position-bearing fixes, so a fix with no lat/lng breaks no hop,
  // while engine time takes every fix, because a unit reporting ignition
  // without a position is still running its engine.
  const dayRowsSql = await prisma.$queryRaw<Array<{
    vehicle_id: string; metres: number | null; seconds: number | null
    on_pings: number | null; moving_pings: number | null
  }>>`
    WITH base AS (
      SELECT t.vehicle_id, t.captured_at, t.lat, t.lng, t.engine_on, t.speed_kmh
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId}
         AND t.captured_at >= ${dayStart} AND t.captured_at <= ${asOf}
    ), pos AS (
      SELECT vehicle_id, lat, lng,
             lag(lat) OVER w AS plat,
             lag(lng) OVER w AS plng
        FROM base
       WHERE lat IS NOT NULL AND lng IS NOT NULL
      WINDOW w AS (PARTITION BY vehicle_id ORDER BY captured_at)
    ), hop AS (
      SELECT vehicle_id,
             6371000 * 2 * asin(sqrt(
               power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat))
                 * power(sin(radians(lng - plng) / 2), 2)
             )) AS metres
        FROM pos WHERE plat IS NOT NULL
    ), dist AS (
      SELECT vehicle_id, sum(metres) AS metres
        FROM hop
       WHERE metres < ${MAX_HOP_KM * 1000}
       GROUP BY vehicle_id
    ), gap AS (
      SELECT vehicle_id,
             lag(engine_on) OVER w AS prev_on,
             extract(epoch FROM (captured_at - lag(captured_at) OVER w)) AS secs
        FROM base
      WINDOW w AS (PARTITION BY vehicle_id ORDER BY captured_at)
    ), eng AS (
      SELECT vehicle_id,
             sum(CASE WHEN prev_on AND secs > 0
                      THEN least(secs, ${MAX_ENGINE_GAP_SECONDS}) ELSE 0 END) AS seconds
        FROM gap
       GROUP BY vehicle_id
    ), sig AS (
      -- Is the ignition flag corroborated by motion? Speed does not come from
      -- the ignition wire, so a unit that moved while never reporting
      -- engine-on has a dead flag rather than a quiet day. 27 units on this
      -- fleet send 500+ pings and never once report it. See
      -- resolveEngineSeconds for what is done with these two counts.
      SELECT vehicle_id,
             count(*) FILTER (WHERE engine_on)::int AS on_pings,
             count(*) FILTER (WHERE speed_kmh >= ${MOTION_MIN_KMH})::int AS moving_pings
        FROM base
       GROUP BY vehicle_id
    )
    SELECT COALESCE(d.vehicle_id, e.vehicle_id) AS vehicle_id,
           d.metres, e.seconds, s.on_pings, s.moving_pings
      FROM dist d
      FULL OUTER JOIN eng e ON e.vehicle_id = d.vehicle_id
      LEFT JOIN sig s ON s.vehicle_id = COALESCE(d.vehicle_id, e.vehicle_id)`

  const distance = new Map<string, number>()
  const engineSeconds = new Map<string, number | null>()
  for (const r of dayRowsSql) {
    if (r.metres != null) distance.set(r.vehicle_id, Math.round(Number(r.metres)))
    if (r.seconds != null) {
      // Null, not zero, when the day's motion contradicts a silent ignition
      // flag — otherwise a dead wire renders as "burned nothing".
      engineSeconds.set(r.vehicle_id, resolveEngineSeconds(
        Math.round(Number(r.seconds)), Number(r.on_pings ?? 0), Number(r.moving_pings ?? 0),
      ))
    }
  }

  // Consumption rates, resolved per vehicle with an org+type fallback. Read
  // from the table the weekly derivation writes — never computed here, which is
  // the point of §7.1 of docs/fuel-consumption-rates.md: this runs whenever an
  // operator opens a tab.
  const rates = await getOrgFuelRates(orgId)

  // Every vehicle that reported on EITHER day gets a row. One that reported
  // yesterday and not today still has an opening balance worth showing, and
  // dropping it would make a silent unit vanish from the table rather than
  // appear with a blank current — which is the thing worth noticing.
  const ids = new Set([...byVehicle.keys(), ...prevClose.keys()])

  return [...ids].map(vehicleId => {
    const readings = byVehicle.get(vehicleId) ?? []
    const prev = prevClose.get(vehicleId) ?? null
    if (readings.length === 0 && prev == null) return { vehicleId, ...UNKNOWN_TANK_STATE }
    return {
      vehicleId,
      ...deriveTankState(readings, prev, {
        priorRunSloshMl: priorRuns.get(vehicleId) ?? [],
        distanceM:       distance.get(vehicleId) ?? null,
        engineSeconds:   engineSeconds.get(vehicleId) ?? null,
        rate:            rates.get(vehicleId) ?? null,
      }),
    }
  })
}
