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
  deriveTankState, UNKNOWN_TANK_STATE, type LevelReading, type TankState,
} from './fuel-tank-state.js'

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

  // The PREVIOUS day's closing level, as one indexed lookup per vehicle rather
  // than another 24 hours of rows. DISTINCT ON walks the
  // (vehicle_id, captured_at) index backwards and stops at the first hit.
  //
  // A single reading, not a median like the day's own close: the medianised
  // value is what this vehicle's own row carried yesterday, and re-deriving it
  // here from a second window would let today's `initial` disagree with
  // yesterday's `current`. Reconciling down a week matters more than smoothing
  // one endpoint twice.
  const prevStart = new Date(dayStart.getTime() - 24 * 3_600_000)
  const prevRows = await prisma.$queryRaw<Array<{ vehicle_id: string; fuel_level_ml: number }>>`
    SELECT DISTINCT ON (t.vehicle_id) t.vehicle_id, t.fuel_level_ml
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND t.captured_at >= ${prevStart}
       AND t.captured_at <  ${dayStart}
       AND t.fuel_level_ml IS NOT NULL
     ORDER BY t.vehicle_id, t.captured_at DESC`
  const prevClose = new Map(prevRows.map(r => [r.vehicle_id, r.fuel_level_ml]))

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
