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
  // The live fleet is every ACTIVE vehicle in the org (RaiFactorySuite registry
  // via sync:vehicles) — vehicles without telemetry yet read as engine-off.
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
      WHERE tt.vehicle_id = v.id
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
    WHERE v.organisation_id = ${orgId} AND v.is_active = true
    ORDER BY v.name
  `
}

/**
 * Two numbers for the whole platform: how many vehicles there are, and how many
 * are moving right now.
 *
 * COUNTS ONLY, and deliberately. This is the one query in the codebase whose
 * result is served to callers with no session, so it returns no plate, no
 * name, no position and no organisation — there is nothing in the result set to
 * attribute to anybody. A `findLatestPerVehicle` without its org filter would
 * have been three lines shorter and would have put the entire platform's fleet
 * on an unauthenticated wire.
 *
 * The moving test is the DASHBOARD'S OWN — `engine_on AND speed > 0` — so the
 * figure on the sign-in screen and the figure in the header mean the same
 * thing rather than two things with one name.
 *
 * One addition to it: a freshness window. The header's count is read by
 * somebody who knows their own fleet and can see a unit's last ping beside it;
 * this one says "right now" to a stranger, and without the window a vehicle
 * whose final ping three days ago had the engine running would be reported as
 * in transit forever. `capturedAt` older than the window counts as parked.
 *
 * The lateral join through `vehicle_telemetry_raws` is kept from
 * findLatestPerVehicle rather than dropped for speed: it is part of what that
 * query means by "latest telemetry", and a cheaper definition here would make
 * the two numbers disagree for reasons nobody could see.
 */
export async function countFleetPulse(freshMs: number): Promise<{ total: number; inTransit: number }> {
  const rows = await prisma.$queryRaw<{ total: number; inTransit: number }[]>`
    SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (
        WHERE COALESCE(t.engine_on, false)
          AND COALESCE(t.speed_kmh, 0) > 0
          AND t.captured_at > NOW() - (${freshMs} || ' milliseconds')::interval
      )::int AS "inTransit"
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT tt.speed_kmh, tt.engine_on, tt.captured_at
      FROM vehicle_telemetries tt
      JOIN vehicle_telemetry_raws rr ON rr.telemetry_id = tt.id
      WHERE tt.vehicle_id = v.id
      ORDER BY tt.captured_at DESC
      LIMIT 1
    ) t ON true
    WHERE v.is_active = true
  `
  return rows[0] ?? { total: 0, inTransit: 0 }
}
