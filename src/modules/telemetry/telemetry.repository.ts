import { prisma } from '../../lib/prisma.js'
import { Prisma } from '../../../generated/prisma/client.js'
import { ALERT_SOURCE } from '../../lib/alerts.js'
import { getSimFleetVehicleIds } from '../../lib/sim-fleet.js'
import type { TelemetryListQuery } from './telemetry.schema.js'

export async function findPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  // Verify vehicle belongs to org before returning data
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  if (!vehicle) return null

  const where = {
    vehicleId,
    ...(q.from || q.to
      ? { capturedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
  }

  const pings = await prisma.vehicleTelemetry.findMany({
    where: { ...where, ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
    orderBy: { capturedAt: 'desc' },
    take: q.limit + 1,
  })

  const hasNextPage = pings.length > q.limit
  if (hasNextPage) pings.pop()
  const nextCursor = hasNextPage ? (pings.at(-1)?.id ?? null) : null

  return { data: pings, cursor: nextCursor?.toString() ?? null, hasNextPage }
}

export async function findLatest(vehicleId: string, orgId: string) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  if (!vehicle) return null

  return prisma.vehicleTelemetry.findFirst({
    where: { vehicleId },
    orderBy: { capturedAt: 'desc' },
  })
}

/** Latest telemetry snapshot for every vehicle in an org — powers the initial map render. */
export async function findFleetSnapshot(orgId: string) {
  // Scope the map to the live-simulation fleet (5 tractors, 8 trucks, 7 lorries).
  const simFleetIds = await getSimFleetVehicleIds()
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, id: { in: simFleetIds } },
    select: {
      id: true,
      name: true,
      registrationPlate: true,
      vehicleType: true,
      tankCapacityLitres: true,
      assignments: {
        where: { unassignedAt: null },
        select: { user: { select: { fullName: true } } },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  })

  const vehicleIds = vehicles.map(v => v.id)
  if (vehicleIds.length === 0) return []

  // Latest NEW-CODE ping per vehicle in ONE query. Filtering to pings whose raw
  // payload carries `_sim.leg` means the snapshot ignores any competing writer's
  // old-format telemetry on the shared DB — the dashboard reflects only this
  // server's simulation (correct positions + journey legs).
  interface PingRow {
    vehicle_id: string
    lat: number | null; lng: number | null; heading_deg: number | null
    speed_kmh: number | null; engine_on: boolean
    fuel_level_ml: number | null; fuel_used_ml: number | null; cargo_weight_kg: number | null
    captured_at: Date; leg: unknown
  }
  const pings = await prisma.$queryRaw<PingRow[]>`
    SELECT DISTINCT ON (t.vehicle_id)
      t.vehicle_id,
      t.lat, t.lng, t.heading_deg, t.speed_kmh, t.engine_on,
      t.fuel_level_ml, t.fuel_used_ml, t.cargo_weight_kg, t.captured_at,
      r.payload->'_sim'->'leg' AS leg
    FROM vehicle_telemetries t
    JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
    WHERE t.vehicle_id IN (${Prisma.join(vehicleIds)})
      AND r.payload->'_sim'->'leg' IS NOT NULL
    ORDER BY t.vehicle_id, t.captured_at DESC
  `
  const pingByVehicle = new Map(pings.map(p => [p.vehicle_id, p]))

  return vehicles.map((v) => {
      const ping            = pingByVehicle.get(v.id)
      const fuelLevelMl     = ping?.fuel_level_ml ?? null
      const tankCapacityMl  = (v.tankCapacityLitres ?? 200) * 1000
      const lowFuel         = fuelLevelMl != null && fuelLevelMl < tankCapacityMl * 0.20
      const fuelLevelPct    = fuelLevelMl != null
        ? Math.round((fuelLevelMl / tankCapacityMl) * 100)
        : null

      return {
        vehicleId:      v.id,
        plate:          v.registrationPlate,
        name:           v.name,
        vehicleType:    v.vehicleType,
        driver:         v.assignments[0]?.user.fullName ?? null,
        lat:            ping?.lat          ?? null,
        lng:            ping?.lng          ?? null,
        headingDeg:     ping?.heading_deg  ?? null,
        speedKmh:       ping?.speed_kmh    ?? null,
        engineOn:       ping?.engine_on    ?? false,
        fuelLevelMl,
        fuelUsedMl:     ping?.fuel_used_ml ?? null,
        cargoWeightKg:  ping?.cargo_weight_kg ?? null,
        capturedAt:     ping?.captured_at?.toISOString() ?? null,
        lowFuel,
        fuelLevelPct,
        leg:            ping?.leg ?? null,
      }
    })
}

export async function findGeofencesForVehicle(vehicleId: string) {
  return prisma.vehicleGeofence.findMany({
    where: { vehicleId },
    include: { geofence: true },
  })
}

/** All currently-open (unresolved) alerts for an org — used to seed the
 *  Operations feed on page load so critical state survives a browser refresh. */
export async function findActiveAlerts(orgId: string) {
  const rows = await prisma.vehicleAlert.findMany({
    // Scope to THIS server's alerts (meta.source) so the feed ignores any
    // competing writer's alerts on the shared DB. A freshly-parked fleet raises
    // none, so the feed starts empty until operations begin.
    where: { organisationId: orgId, resolvedAt: null, meta: { path: ['source'], equals: ALERT_SOURCE } },
    include: {
      vehicle: { select: { name: true, registrationPlate: true } },
    },
    orderBy: { triggeredAt: 'desc' },
  })
  return rows.map(r => ({
    id:          r.id,
    alertType:   r.type,
    severity:    r.severity,
    title:       r.message,
    vehicleId:   r.vehicleId,
    vehicleName: r.vehicle.name,
    plate:       r.vehicle.registrationPlate,
    lat:         r.lat,
    lng:         r.lng,
    speedKmh:    r.speedKmh,
    fuelLevelMl: r.fuelLevelMl,
    triggeredAt: r.triggeredAt.toISOString(),
  }))
}
