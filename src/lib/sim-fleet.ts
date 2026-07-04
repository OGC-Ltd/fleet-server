/**
 * Live-simulation fleet scope.
 *
 * The organisation has 100 seeded vehicles (10 vehicle types × 10 each — see
 * prisma/seed.ts's VEHICLE_TYPES), but the live simulation (and the map/feed
 * that mirror it) run a small, fixed fleet so the operation is easy to
 * follow: every tractor, truck, and lorry — 10 of each, 30 total, which is
 * also the most this composition can reach without silently under-filling,
 * since the seed only creates 10 vehicles per type. This is a NON-destructive
 * filter — the other vehicles remain in the DB with their history intact; they
 * simply aren't ticked by the simulator or shown on the live map.
 *
 * Both the simulator (which vehicles to tick) and the fleet snapshot (which
 * vehicles the map shows) resolve the fleet through this single module so they
 * always agree.
 */

import { prisma } from './prisma.js'

// Fleet composition — [vehicleType, count]. Order is stable so the selection
// is deterministic across the simulator and the snapshot. 10 is the max
// available per type in the seed (100 vehicles ÷ 10 types).
export const SIM_FLEET_COMPOSITION: Array<[string, number]> = [
  ['TRACTOR', 10],
  ['TRUCK',   10],
  ['LORRY',   10],
]

export const SIM_FLEET_SIZE = SIM_FLEET_COMPOSITION.reduce((n, [, c]) => n + c, 0)

export interface SimFleetVehicle {
  id:                 string
  deviceId:           string
  organisationId:     string
  tankCapacityLitres: number | null
  vehicleType:        string
}

let cached: SimFleetVehicle[] | null = null

/**
 * The vehicles included in the live simulation: the first N of each type by
 * registration plate (deterministic). Cached for the process lifetime.
 */
export async function getSimFleetVehicles(): Promise<SimFleetVehicle[]> {
  if (cached) return cached
  const out: SimFleetVehicle[] = []
  for (const [vehicleType, count] of SIM_FLEET_COMPOSITION) {
    const rows = await prisma.vehicle.findMany({
      where:   { vehicleType },
      orderBy: { registrationPlate: 'asc' },
      take:    count,
      select:  { id: true, deviceId: true, organisationId: true, tankCapacityLitres: true, vehicleType: true },
    })
    out.push(...rows)
  }
  cached = out
  return out
}

/** Vehicle IDs in the live simulation — used to scope the fleet snapshot. */
export async function getSimFleetVehicleIds(): Promise<string[]> {
  return (await getSimFleetVehicles()).map(v => v.id)
}
