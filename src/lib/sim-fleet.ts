/**
 * Live-simulation fleet scope — org-aware.
 *
 * Two organisations run concurrently in the live simulation:
 *
 *  - SUKARI   (Sukari Industries Limited): 100 seeded vehicles (40 lorry &
 *    trailer, 40 canter, 20 pickup), of which the live sim ticks 30 —
 *    15 lorry & trailer, 10 canter, 5 pickup. Routing: mill ↔ sugar depots.
 *
 *  - AQUAMIST (Aquamist Limited): 10 seeded vehicles, ALL in the live sim —
 *    4 saloon cars, 3 trucks, 3 lorries. No depots: vehicles deliver bottled
 *    water, sparkling water, and juice from the Aquamist plant directly to
 *    customers in different parts of Nairobi, Kisumu, Nakuru, and Mombasa.
 *
 * Selection is scoped BY ORGANISATION FIRST, then vehicle type — so Sukari's
 * trucks and Aquamist's trucks never mix. This is a NON-destructive filter:
 * vehicles outside the composition remain in the DB with their history intact;
 * they simply aren't ticked by the simulator or shown on the live map.
 *
 * Both the simulator (which vehicles to tick) and the fleet snapshot (which
 * vehicles the map shows) resolve the fleet through this single module so they
 * always agree.
 */

import { prisma } from './prisma.js'

export interface OrgFleetComposition {
  orgCode: string
  /** [vehicleType, count] — order is stable so selection is deterministic. */
  types: Array<[string, number]>
}

// Re-registration of 2026-07-09 replaced most orgs' SALOON/TRUCK/LORRY
// vehicles with LORRY & TRAILER / CANTER / PICKUP plates — each org's type
// mix below must mirror what its vehicles table actually holds, or the type
// filter selects nothing and the org's fleet silently vanishes from the sim.
export const SIM_FLEET_COMPOSITION: OrgFleetComposition[] = [
  { orgCode: 'SUKARI',   types: [['LORRY & TRAILER', 15], ['CANTER', 10], ['PICKUP', 5]] },
  { orgCode: 'AQUAMIST', types: [['LORRY & TRAILER', 5],  ['PICKUP', 3],  ['CANTER', 2]] },
  // Direct-delivery orgs added 2026-07 — see DIRECT_PROFILES in
  // controltech.simulator.ts for each org's HQ / customers / products.
  { orgCode: 'MENENGAI', types: [['CANTER', 6],  ['LORRY & TRAILER', 5],  ['PICKUP', 4]] },                // 15 — edible oils, Nakuru
  { orgCode: 'TIMSALES', types: [['LORRY & TRAILER', 10], ['CANTER', 6],  ['PICKUP', 4]] },                // 20 — timber, Elburgon
  { orgCode: 'KABRAS',   types: [['TRUCK', 7], ['CANTER', 6], ['LORRY & TRAILER', 5], ['PICKUP', 4], ['LORRY', 3]] }, // 25 — sugar, Malava
]

export const SIM_FLEET_SIZE = SIM_FLEET_COMPOSITION
  .reduce((n, o) => n + o.types.reduce((m, [, c]) => m + c, 0), 0)

export interface SimFleetVehicle {
  id:                 string
  deviceId:           string
  organisationId:     string
  orgCode:            string
  tankCapacityLitres: number | null
  vehicleType:        string
}

let cached: SimFleetVehicle[] | null = null

/**
 * The vehicles included in the live simulation: per organisation, the first N
 * of each type by registration plate (deterministic). An org that hasn't been
 * seeded yet is skipped, so the sim still boots on a pre-Aquamist database.
 * Cached for the process lifetime.
 */
export async function getSimFleetVehicles(): Promise<SimFleetVehicle[]> {
  if (cached) return cached
  const out: SimFleetVehicle[] = []
  for (const { orgCode, types } of SIM_FLEET_COMPOSITION) {
    const org = await prisma.organisation.findUnique({ where: { code: orgCode }, select: { id: true } })
    if (!org) continue
    for (const [vehicleType, count] of types) {
      const rows = await prisma.vehicle.findMany({
        where:   { organisationId: org.id, vehicleType },
        orderBy: { registrationPlate: 'asc' },
        take:    count,
        select:  { id: true, deviceId: true, organisationId: true, tankCapacityLitres: true, vehicleType: true },
      })
      out.push(...rows.map(r => ({ ...r, orgCode })))
    }
  }
  cached = out
  return out
}

/** Vehicle IDs in the live simulation — used to scope the fleet snapshot. */
export async function getSimFleetVehicleIds(): Promise<string[]> {
  return (await getSimFleetVehicles()).map((v) => v.id)
}
