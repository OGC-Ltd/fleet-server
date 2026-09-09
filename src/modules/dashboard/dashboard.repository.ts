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
 * The platform's fleet, reduced to what the pulse needs to grade it.
 *
 * NOTHING ATTRIBUTABLE LEAVES THE SERVER. This feeds the one endpoint served to
 * callers with no session, and the caller turns these rows into two integers —
 * no plate, no name, no position, no organisation ever reaches the wire. The
 * `deviceId` here is read only to look up the provider's connection verdict and
 * is discarded in the same function; a `findLatestPerVehicle` without its org
 * filter would have been shorter and would have put the entire platform's fleet
 * on an unauthenticated wire.
 *
 * ## Why rows rather than a COUNT
 *
 * This used to count in SQL — `engine_on AND speed > 0 AND captured_at` inside
 * a freshness window — and it could not do otherwise, because the test the
 * dashboard actually applies is not expressible here. "In transit" on the
 * dashboard means the PROVIDER says the tracker is connected, and that verdict
 * lives in an in-memory map fed by the reconcile sweep (lib/connection-state),
 * deliberately never persisted. No SQL can join it.
 *
 * So the freshness window stood in for it, and a window is a measurably
 * different question. Against the live Kasulu account a 15-minute window
 * disagreed with Wialon's own verdict on 28 of 224 units — 25 of them units
 * Wialon called OFFLINE while the window called them online. That is the gap
 * the sign-in number carried: it counted units the dashboard would not.
 *
 * The lateral join through `vehicle_telemetry_raws` is kept from
 * findLatestPerVehicle rather than dropped for speed: it is part of what that
 * query means by "latest telemetry", and a cheaper definition here would make
 * the two numbers disagree for reasons nobody could see.
 */
export interface PulseRow {
  /** The provider's unit id, for the connection lookup. Never leaves the server. */
  deviceId: string | null
  speedKmh: number | null
  engineOn: boolean | null
}

export async function findFleetPulseRows(): Promise<PulseRow[]> {
  return prisma.$queryRaw<PulseRow[]>`
    SELECT
      v.device_id                  AS "deviceId",
      t.speed_kmh                  AS "speedKmh",
      COALESCE(t.engine_on, false) AS "engineOn"
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
}
