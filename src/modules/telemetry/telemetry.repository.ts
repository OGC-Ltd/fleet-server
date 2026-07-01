import { prisma } from '../../lib/prisma.js'
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
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId },
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

  const rows = await Promise.all(
    vehicles.map(async (v) => {
      const ping = await prisma.vehicleTelemetry.findFirst({
        where: { vehicleId: v.id },
        orderBy: { capturedAt: 'desc' },
        select: {
          lat: true, lng: true, headingDeg: true,
          speedKmh: true, engineOn: true,
          fuelLevelMl: true, fuelUsedMl: true,
          cargoWeightKg: true,
          capturedAt: true,
        },
      })
      const fuelLevelMl     = ping?.fuelLevelMl  ?? null
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
        headingDeg:     ping?.headingDeg   ?? null,
        speedKmh:       ping?.speedKmh     ?? null,
        engineOn:       ping?.engineOn     ?? false,
        fuelLevelMl,
        fuelUsedMl:     ping?.fuelUsedMl   ?? null,
        cargoWeightKg:  ping?.cargoWeightKg ?? null,
        capturedAt:     ping?.capturedAt?.toISOString() ?? null,
        lowFuel,
        fuelLevelPct,
      }
    }),
  )
  return rows
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
    where: { organisationId: orgId, resolvedAt: null },
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
