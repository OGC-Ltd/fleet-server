import { prisma } from '../../lib/prisma.js'
import type { AnalyticsRange, SpeedingQuery, DeliveriesQuery } from './analytics.schema.js'

// A delivery counts as "interrupted"/delayed when it took materially longer than
// its moving time (distance ÷ average speed) implies — i.e. it spent a lot of
// the journey stopped (breakdown/refuel halt, long waits, route deviation). This
// threshold is the actual-vs-expected duration ratio above which a trip is
// flagged; below it the delivery was "timely". 2× is deliberately conservative
// — a delivery that took at least double its moving time clearly stalled en
// route — so normal loading/idle overhead doesn't get mislabelled as
// interrupted. (Alert-overlap was tried first but halts in this data occur
// between trips, not within a trip window.)
const INTERRUPTED_RATIO = 2.0

/**
 * Deliveries dashboard aggregate over the trailing `days` window: everything
 * derived from the real persisted Trip + CargoManifest + VehicleAlert rows —
 * products ferried, busiest days, depots served (most→least), timely vs
 * interrupted deliveries, and distance covered (with per-day/week/month means).
 */
export async function deliveriesAnalytics(orgId: string, q: DeliveriesQuery) {
  // The simulation clock runs ahead of real wall-clock time, so anchor the
  // trailing window to the latest trip (the newest data the dashboard shows)
  // rather than `new Date()` — otherwise the most recent sim days get chopped.
  let to = q.to
  if (!to) {
    const latest = await prisma.trip.aggregate({
      where: { vehicle: { organisationId: orgId } },
      _max:  { beganAt: true },
    })
    to = latest._max.beganAt ?? new Date()
  }
  const from = new Date(to.getTime() - q.days * 86_400_000)

  const trips = await prisma.trip.findMany({
    where:  { vehicle: { organisationId: orgId }, beganAt: { gte: from, lte: to } },
    select: {
      beganAt: true, finalLocation: true, mileageKm: true,
      durationSeconds: true, avgSpeedKmh: true,
      cargoManifest: { select: { description: true, arrivalWeightKg: true } },
    },
    orderBy: { beganAt: 'asc' },
  })

  const products  = new Map<string, { trips: number; kg: number }>()
  const depots    = new Map<string, { trips: number; kg: number }>()
  const byDay     = new Map<string, { trips: number; kg: number; km: number; timely: number }>()
  const byWeekday = Array.from({ length: 7 }, () => 0) // 0=Sun … 6=Sat
  let totalKm = 0, totalKg = 0, interrupted = 0

  const bump = (m: Map<string, { trips: number; kg: number }>, key: string, kg: number) => {
    const e = m.get(key) ?? { trips: 0, kg: 0 }
    e.trips += 1; e.kg += kg; m.set(key, e)
  }

  for (const t of trips) {
    const product = t.cargoManifest?.description ?? 'Unspecified'
    const kg      = t.cargoManifest?.arrivalWeightKg ?? 0
    const km      = t.mileageKm ?? 0
    const depot   = t.finalLocation ?? 'Unknown'
    const dayKey  = t.beganAt.toISOString().slice(0, 10)

    const expectedHours = t.avgSpeedKmh && t.avgSpeedKmh > 0 && km ? km / t.avgSpeedKmh : null
    const isInterrupted = expectedHours != null && t.durationSeconds / 3600 > expectedHours * INTERRUPTED_RATIO
    if (isInterrupted) interrupted += 1

    bump(products, product, kg)
    bump(depots, depot, kg)
    const d = byDay.get(dayKey) ?? { trips: 0, kg: 0, km: 0, timely: 0 }
    d.trips += 1; d.kg += kg; d.km += km; if (!isInterrupted) d.timely += 1; byDay.set(dayKey, d)
    byWeekday[t.beganAt.getUTCDay()] += 1
    totalKm += km; totalKg += kg
  }

  const t1 = (kg: number) => Math.round(kg / 100) / 10 // kg → tonnes, 1 dp
  const activeDays = byDay.size || 1
  const perDayKm   = totalKm / activeDays

  return {
    totals: {
      trips:      trips.length,
      tonnes:     t1(totalKg),
      distanceKm: Math.round(totalKm),
      windowDays: q.days,
      activeDays,
    },
    products: [...products].map(([product, v]) => ({ product, trips: v.trips, tonnes: t1(v.kg) }))
      .sort((a, b) => b.tonnes - a.tonnes),
    depots: [...depots].map(([depot, v]) => ({ depot, trips: v.trips, tonnes: t1(v.kg) }))
      .sort((a, b) => b.tonnes - a.tonnes),
    byDay: [...byDay].map(([day, v]) => ({ day, trips: v.trips, tonnes: t1(v.kg), distanceKm: Math.round(v.km), timely: v.timely }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    byWeekday: byWeekday.map((trips, weekday) => ({ weekday, trips })), // weekday 0=Sun
    deliveries: { total: trips.length, timely: trips.length - interrupted, interrupted },
    distance: {
      totalKm:    Math.round(totalKm),
      perDayKm:   Math.round(perDayKm),
      perWeekKm:  Math.round(perDayKm * 7),
      perMonthKm: Math.round(perDayKm * 30),
    },
  }
}

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
    select: { id: true, registrationPlate: true },
  })
  const vehicleMap = new Map(vehicles.map(v => [v.id, v.registrationPlate]))

  return rows.map(r => ({
    vehicleId:   r.vehicleId,
    registrationPlate: vehicleMap.get(r.vehicleId) ?? null,
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
    select: { id: true, registrationPlate: true },
  })
  const vehicleMap = new Map(vehicles.map(v => [v.id, v.registrationPlate]))

  return pings.map(ping => ({
    vehicleId:   ping.vehicleId,
    registrationPlate: vehicleMap.get(ping.vehicleId) ?? null,
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

