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

export async function findGeofencesForVehicle(vehicleId: string) {
  return prisma.vehicleGeofence.findMany({
    where: { vehicleId },
    include: { geofence: true },
  })
}
