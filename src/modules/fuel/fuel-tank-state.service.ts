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
    select:  { vehicleId: true, capturedAt: true, fuelLevelMl: true, engineOn: true },
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
    const s = { capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl!, engineOn: r.engineOn }
    const list = byVehicle.get(r.vehicleId)
    if (list) list.push(s)
    else byVehicle.set(r.vehicleId, [s])
  }

  // Every vehicle that reported on EITHER day gets a row. One that reported
  // yesterday and not today still has an opening balance worth showing, and
  // dropping it would make a silent unit vanish from the table rather than
  // appear with a blank current — which is the thing worth noticing.
  const ids = new Set([...byVehicle.keys(), ...prevClose.keys()])

  return [...ids].map(vehicleId => {
    const readings = byVehicle.get(vehicleId) ?? []
    const prev = prevClose.get(vehicleId) ?? null
    if (readings.length === 0 && prev == null) return { vehicleId, ...UNKNOWN_TANK_STATE }
    return { vehicleId, ...deriveTankState(readings, prev) }
  })
}
