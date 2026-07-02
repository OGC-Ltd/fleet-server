import { prisma } from '../../lib/prisma.js'
import { Prisma } from '../../../generated/prisma/client.js'
import { getSimFleetVehicleIds } from '../../lib/sim-fleet.js'

/** All silos for an org, grouped by sugar type then name (powers the storage KPI). */
export async function findSilos(orgId: string) {
  return prisma.silo.findMany({
    where: { organisationId: orgId },
    orderBy: [{ sugarType: 'asc' }, { name: 'asc' }],
  })
}

export interface FleetRow {
  vehicleId:          string
  plate:              string
  name:               string
  vehicleType:        string
  tankCapacityLitres: number | null
  driver:             string | null
  lat:                number | null
  lng:                number | null
  speedKmh:           number | null
  engineOn:           boolean
  fuelLevelMl:        number | null
  cargoWeightKg:      number | null
  capturedAt:         Date | null
}

/**
 * Latest telemetry ping per vehicle for an org, in a SINGLE query.
 *
 * The map's `findFleetSnapshot` issues one findFirst per vehicle (N+1 = 100
 * round-trips) which is far too slow for a KPI endpoint polled every 30 s over
 * the remote pooler. Two LATERAL subqueries — one for the latest ping, one for
 * the active driver — let Postgres use the `(vehicle_id, captured_at)` index to
 * grab a single row per vehicle (100 cheap index seeks, one statement, one
 * pooled connection) instead of scanning the whole telemetry table.
 */
export async function findLatestPerVehicle(orgId: string): Promise<FleetRow[]> {
  // Scope to the live-simulation fleet (20 vehicles) and to NEW-CODE telemetry
  // (raw carries _sim.leg), so the KPIs reflect this server's simulation and
  // ignore any competing writer on the shared DB.
  const simFleetIds = await getSimFleetVehicleIds()
  if (simFleetIds.length === 0) return []
  return prisma.$queryRaw<FleetRow[]>`
    SELECT
      v.id                         AS "vehicleId",
      v.registration_plate         AS "plate",
      v.name                       AS "name",
      v.vehicle_type               AS "vehicleType",
      v.tank_capacity_litres       AS "tankCapacityLitres",
      drv.full_name                AS "driver",
      t.lat                        AS "lat",
      t.lng                        AS "lng",
      t.speed_kmh                  AS "speedKmh",
      COALESCE(t.engine_on, false) AS "engineOn",
      t.fuel_level_ml              AS "fuelLevelMl",
      t.cargo_weight_kg            AS "cargoWeightKg",
      t.captured_at                AS "capturedAt"
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT tt.lat, tt.lng, tt.speed_kmh, tt.engine_on, tt.fuel_level_ml, tt.cargo_weight_kg, tt.captured_at
      FROM vehicle_telemetries tt
      JOIN vehicle_telemetry_raws rr ON rr.telemetry_id = tt.id
      WHERE tt.vehicle_id = v.id AND rr.payload->'_sim'->'leg' IS NOT NULL
      ORDER BY tt.captured_at DESC
      LIMIT 1
    ) t ON true
    LEFT JOIN LATERAL (
      SELECT u.full_name
      FROM vehicle_assignments va
      JOIN users u ON u.id = va.user_id
      WHERE va.vehicle_id = v.id AND va.unassigned_at IS NULL
      LIMIT 1
    ) drv ON true
    WHERE v.organisation_id = ${orgId} AND v.id IN (${Prisma.join(simFleetIds)})
    ORDER BY v.name
  `
}
