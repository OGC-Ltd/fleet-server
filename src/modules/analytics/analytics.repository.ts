import { prisma } from '../../lib/prisma.js'
import type { AnalyticsRange, SpeedingQuery } from './analytics.schema.js'

export async function fleetOverview(orgId: string) {
  const [totalVehicles, ongoingTrips, fenceViolations, activePings] = await Promise.all([
    prisma.vehicle.count({ where: { organisationId: orgId } }),
    // Count trips that ended within the last hour as a proxy for "ongoing"
    prisma.trip.count({ where: { vehicle: { organisationId: orgId }, endedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } }),
    prisma.geofenceViolation.count({
      where: {
        vehicle: { organisationId: orgId },
        occurredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        resolvedAt: null,
      },
    }),
    prisma.vehicleTelemetry.groupBy({
      by: ['vehicleId'],
      where: {
        vehicle: { organisationId: orgId },
        capturedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        engineOn: true,
      },
      _count: true,
    }).then(r => r.length),
  ])
  return { totalVehicles, activeVehicles: activePings, recentTrips: ongoingTrips, openViolations24h: fenceViolations }
}

export async function fuelEfficiency(orgId: string, q: AnalyticsRange) {
  const rows = await prisma.vehicleTelemetry.groupBy({
    by: ['vehicleId'],
    where: {
      vehicle: { organisationId: orgId },
      capturedAt: { gte: q.from, lte: q.to },
      fuelUsedMl: { not: null },
    },
    _sum: { fuelUsedMl: true },
    _count: { id: true },
  })

  const vehicleIds = rows.map(r => r.vehicleId)
  const vehicles = await prisma.vehicle.findMany({
    where:  { id: { in: vehicleIds } },
    select: { id: true, plateNumber: true },
  })
  const vehicleMap = new Map(vehicles.map(v => [v.id, v.plateNumber]))

  return rows.map(r => ({
    vehicleId:   r.vehicleId,
    plateNumber: vehicleMap.get(r.vehicleId) ?? null,
    totalFuelMl: r._sum.fuelUsedMl ?? 0,
    pingCount:   r._count.id,
  }))
}

export async function speedingEvents(orgId: string, q: SpeedingQuery) {
  const pings = await prisma.vehicleTelemetry.findMany({
    where: {
      vehicle: { organisationId: orgId },
      capturedAt: { gte: q.from, lte: q.to },
      speedKmh:   { gt: q.thresholdKmh },
    },
    select: {
      vehicleId:  true,
      capturedAt: true,
      speedKmh:   true,
      lat:        true,
      lng:        true,
    },
    orderBy: { speedKmh: 'desc' },
    take:    500,
  })

  const vehicleIds = [...new Set(pings.map(p => p.vehicleId))]
  const vehicles = await prisma.vehicle.findMany({
    where:  { id: { in: vehicleIds } },
    select: { id: true, plateNumber: true },
  })
  const vehicleMap = new Map(vehicles.map(v => [v.id, v.plateNumber]))

  return pings.map(ping => ({
    vehicleId:   ping.vehicleId,
    plateNumber: vehicleMap.get(ping.vehicleId) ?? null,
    capturedAt:  ping.capturedAt,
    speedKmh:    ping.speedKmh,
    lat:         ping.lat,
    lng:         ping.lng,
  }))
}

export async function violationHeatmap(orgId: string, q: AnalyticsRange) {
  return prisma.geofenceViolation.findMany({
    where: {
      vehicle:    { organisationId: orgId },
      occurredAt: { gte: q.from, lte: q.to },
    },
    select:  { lat: true, lng: true, occurredAt: true, geofenceId: true, vehicleId: true },
    orderBy: { occurredAt: 'desc' },
    take:    1000,
  })
}
