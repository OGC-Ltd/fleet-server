import { prisma } from '../../lib/prisma.js'

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
      SELECT lat, lng, speed_kmh, engine_on, fuel_level_ml, cargo_weight_kg, captured_at
      FROM vehicle_telemetries
      WHERE vehicle_id = v.id
      ORDER BY captured_at DESC
      LIMIT 1
    ) t ON true
    LEFT JOIN LATERAL (
      SELECT u.full_name
      FROM vehicle_assignments va
      JOIN users u ON u.id = va.user_id
      WHERE va.vehicle_id = v.id AND va.unassigned_at IS NULL
      LIMIT 1
    ) drv ON true
    WHERE v.organisation_id = ${orgId}
    ORDER BY v.name
  `
}
