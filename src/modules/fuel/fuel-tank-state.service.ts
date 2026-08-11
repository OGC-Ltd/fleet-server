/**
 * Per-vehicle tank state for the Fuel FSL table.
 *
 * The rule is in `fuel-tank-state.ts` and is pure; this is the plumbing.
 *
 * ONE query for the whole org rather than one per vehicle. A fleet of 200 units
 * would otherwise cost 200 round trips to the same pooler the 2-second
 * telemetry poll is using, for a table that redraws whenever an operator opens
 * a tab. Grouping in memory is cheap; the round trips are not.
 */

import { prisma } from '../../lib/prisma.js'
import {
  deriveTankState, STOP_MINUTES, UNKNOWN_TANK_STATE, type TankState,
} from './fuel-tank-state.js'

/**
 * How far back to read.
 *
 * Long enough to contain the previous stop for a machine that has been working
 * since dawn, and no longer: this is a live table, and a window that stretched
 * to days would make every open of the tab an expensive scan. A unit still
 * working after 14 hours simply has no `initialMl`, which the table renders
 * blank rather than guessing.
 */
const WINDOW_HOURS = 14

export interface VehicleTankState extends TankState {
  vehicleId: string
}

export async function getFleetTankState(orgId: string, now = new Date()): Promise<VehicleTankState[]> {
  const from = new Date(now.getTime() - WINDOW_HOURS * 3_600_000)

  const rows = await prisma.vehicleTelemetry.findMany({
    where: {
      vehicle:    { organisationId: orgId },
      capturedAt: { gte: from },
      fuelLevelMl: { not: null },
    },
    select:  { vehicleId: true, capturedAt: true, fuelLevelMl: true, engineOn: true },
    orderBy: { capturedAt: 'asc' },
  })

  const byVehicle = new Map<string, { capturedAt: Date; fuelLevelMl: number; engineOn?: boolean }[]>()
  for (const r of rows) {
    const list = byVehicle.get(r.vehicleId)
    const s = { capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl!, engineOn: r.engineOn }
    if (list) list.push(s)
    else byVehicle.set(r.vehicleId, [s])
  }

  return [...byVehicle].map(([vehicleId, samples]) => ({
    vehicleId,
    // A vehicle whose whole window is one working period has no previous stop
    // to measure from, and gets nulls rather than a fabricated baseline.
    ...(samples.length > 0 ? deriveTankState(samples) : UNKNOWN_TANK_STATE),
  }))
}

export { STOP_MINUTES }
