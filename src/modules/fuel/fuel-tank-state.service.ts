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
  closingLevel, deriveTankState, UNKNOWN_TANK_STATE,
  type LevelReading, type TankState,
} from './fuel-tank-state.js'

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

  // Ground covered today, summed from the position fixes.
  //
  // There is no odometer on vehicle_telemetries — Wialon's counter reaches the
  // snapshot but is not persisted per ping — so distance is the sum of
  // great-circle hops between consecutive fixes. Computed in SQL rather than in
  // JS because it needs EVERY fix, including the ones with no fuel reading that
  // the day query above filters out; pulling those into memory as well would
  // roughly double the payload for one number.
  //
  // Haversine written out rather than PostGIS: ST_DistanceSphere would do, but
  // this needs no extension to be present and the arithmetic is not the hard
  // part. Hops longer than MAX_HOP_KM are dropped — at a 30-second ping that is
  // over 600 km/h, so it is a GPS jump rather than travel, and one such fix
  // would otherwise add hundreds of kilometres to a vehicle's day.
  const distRows = await prisma.$queryRaw<Array<{ vehicle_id: string; metres: number }>>`
    WITH p AS (
      SELECT t.vehicle_id, t.lat, t.lng,
             lag(t.lat) OVER (PARTITION BY t.vehicle_id ORDER BY t.captured_at) AS plat,
             lag(t.lng) OVER (PARTITION BY t.vehicle_id ORDER BY t.captured_at) AS plng
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId}
         AND t.captured_at >= ${dayStart} AND t.captured_at <= ${asOf}
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL
    ), hop AS (
      SELECT vehicle_id,
             6371000 * 2 * asin(sqrt(
               power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat))
                 * power(sin(radians(lng - plng) / 2), 2)
             )) AS metres
        FROM p WHERE plat IS NOT NULL
    )
    SELECT vehicle_id, sum(metres) AS metres
      FROM hop
     WHERE metres < ${MAX_HOP_KM * 1000}
     GROUP BY vehicle_id`
  const distance = new Map(distRows.map(r => [r.vehicle_id, Math.round(Number(r.metres))]))

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
      ...deriveTankState(
        readings, prev, priorRuns.get(vehicleId) ?? [], distance.get(vehicleId) ?? null,
      ),
    }
  })
}
