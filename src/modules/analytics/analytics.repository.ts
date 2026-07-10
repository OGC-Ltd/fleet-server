import { prisma } from '../../lib/prisma.js'
import { getSimFleetVehicleIds } from '../../lib/sim-fleet.js'
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

// A driver is any org user holding one of the driver roles (see prisma/seed.ts).
const DRIVER_ROLE_SLUGS = ['driver', 'senior_driver', 'junior_driver']

// Overspeeding threshold (km/h) — matches the server's speeding-query default.
const OVERSPEED_LIMIT_KMH = 80

// kg → tonnes, 1 dp (shared with deliveriesAnalytics' presentation).
const toTonnes = (kg: number) => Math.round(kg / 100) / 10

export interface DriverRosterRow {
  id:                string
  fullName:          string
  status:            string
  rating:            number
  trips:             number
  tonnes:            number
  mileageKm:         number
  fuelTheftCases:    number
  overspeedingCases: number
}

export interface DriverDetail {
  driver: {
    id: string; fullName: string; status: string; rating: number
    licenceNumber: string | null; employeeId: string | null
  }
  totals: {
    trips: number; mileageKm: number; tonnes: number; hoursOnRoad: number
    fuelTheftCases: number; overspeedingCases: number; windowDays: number
  }
  heaviestLoad: { tonnes: number; date: string; route: string } | null
  byDay: { day: string; tonnes: number; mileageKm: number }[]
}

export interface DriversOverview {
  windowDays:  number
  generatedAt: string
  /** Roster with lifetime aggregates, sorted by tonnes ferried (desc). */
  drivers: DriverRosterRow[]
  /** Per-driver windowed analytics, keyed by driver id — same payload shape
   *  as the single-driver endpoint, so one response serves every selection. */
  details: Record<string, DriverDetail>
}

/**
 * Roster + per-driver analytics for EVERY driver in one pass — the batched
 * source behind /analytics/drivers, /analytics/drivers/:id and the
 * /analytics/drivers/overview endpoint the Drivers page consumes.
 *
 * The roster is the ACTIVE DRIVING WORKFORCE: users currently assigned to a
 * live-fleet vehicle — the same assignment join the fleet snapshot uses, so
 * the Drivers page and the Maintenance vehicle grid always show the same
 * people. Falls back to role-holders if the org has no assignments. Lifetime
 * aggregates (trips, tonnes, mileage, theft/overspeed cases) come from real
 * Trip + CargoManifest + FuelTheft + VehicleAlert rows; each driver's detail
 * covers a trailing `days` window anchored to that driver's latest trip (the
 * sim clock runs ahead of wall-clock time), mirroring deliveriesAnalytics.
 *
 * The DB round trip is the expensive part (remote pooler), so everything is
 * fetched in 3 parallel queries after the roster lookup and aggregated in JS
 * — this function is also what the drivers-overview cache warms so requests
 * never wait on the database.
 */
export async function driversOverview(orgId: string, days: number): Promise<DriversOverview> {
  // Mirror findFleetSnapshot's assignment join EXACTLY (take 1 active
  // assignment per vehicle) so the roster is precisely the set of names the
  // vehicle grid displays — vehicles with extra active relief assignments
  // would otherwise add drivers the grid never shows.
  const userSelect = {
    id: true, fullName: true, status: true, driverRatingScore: true,
    licenceNumber: true, employeeId: true,
  } as const
  const simFleetIds = await getSimFleetVehicleIds()
  const fleet = await prisma.vehicle.findMany({
    where: { organisationId: orgId, id: { in: simFleetIds } },
    select: {
      assignments: {
        where: { unassignedAt: null },
        select: { user: { select: userSelect } },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  })
  // One row per driver even if they crew several vehicles.
  const byId = new Map(fleet.flatMap(v => v.assignments).map(a => [a.user.id, a.user]))
  let drivers = [...byId.values()]

  if (drivers.length === 0) {
    drivers = await prisma.user.findMany({
      where: {
        organisationId: orgId,
        deletedAt: null,
        userRoles: { some: { revokedAt: null, role: { slug: { in: DRIVER_ROLE_SLUGS } } } },
      },
      select: userSelect,
    })
  }
  const driverIds = drivers.map(d => d.id)

  // Everything both the roster and the per-driver details need, in one round
  // trip each: the drivers' full trip history (with cargo + route for tonnage
  // and the heaviest-load callout), their fuel-theft rows, and the org's
  // overspeeding alerts (attributed to trips by vehicle + time window below).
  const [trips, thefts, alerts] = await Promise.all([
    prisma.trip.findMany({
      where:  { driverId: { in: driverIds }, vehicle: { organisationId: orgId } },
      select: {
        driverId: true, vehicleId: true, beganAt: true, endedAt: true,
        mileageKm: true, durationSeconds: true, finalLocation: true,
        route:         { select: { name: true, originName: true, destinationName: true } },
        cargoManifest: { select: { arrivalWeightKg: true } },
      },
      orderBy: { beganAt: 'asc' },
    }),
    prisma.fuelTheft.findMany({
      where:  { driverId: { in: driverIds }, vehicle: { organisationId: orgId } },
      select: { driverId: true, beganAt: true },
    }),
    prisma.vehicleAlert.findMany({
      where:  { organisationId: orgId, type: 'overspeeding' },
      select: { vehicleId: true, triggeredAt: true },
    }),
  ])

  type TripRow = (typeof trips)[number]
  const tripsByDriver = new Map<string, TripRow[]>()
  const tripsByVehicle = new Map<string, TripRow[]>()
  for (const t of trips) {
    if (t.driverId) {
      const arr = tripsByDriver.get(t.driverId) ?? []
      arr.push(t); tripsByDriver.set(t.driverId, arr)
    }
    const varr = tripsByVehicle.get(t.vehicleId) ?? []
    varr.push(t); tripsByVehicle.set(t.vehicleId, varr)
  }

  const theftsByDriver = new Map<string, Date[]>()
  for (const th of thefts) {
    if (!th.driverId) continue
    const arr = theftsByDriver.get(th.driverId) ?? []
    arr.push(th.beganAt); theftsByDriver.set(th.driverId, arr)
  }

  // Lifetime overspeeding cases per driver: attribute each org overspeeding
  // alert to the trip (matching vehicle + time window) running when it fired.
  const overspeedByDriver = new Map<string, number>()
  for (const a of alerts) {
    const hit = (tripsByVehicle.get(a.vehicleId) ?? []).find(t =>
      t.driverId && a.triggeredAt >= t.beganAt && (t.endedAt == null || a.triggeredAt <= t.endedAt),
    )
    if (hit?.driverId) overspeedByDriver.set(hit.driverId, (overspeedByDriver.get(hit.driverId) ?? 0) + 1)
  }

  const roster: DriverRosterRow[] = []
  const details: Record<string, DriverDetail> = {}

  for (const d of drivers) {
    const dTrips = tripsByDriver.get(d.id) ?? []
    const dThefts = theftsByDriver.get(d.id) ?? []
    const rating = Math.round((d.driverRatingScore ?? 0) * 10) / 10

    // ── Roster row: lifetime aggregates ──
    let lifetimeKm = 0, lifetimeKg = 0
    for (const t of dTrips) {
      lifetimeKm += t.mileageKm ?? 0
      lifetimeKg += t.cargoManifest?.arrivalWeightKg ?? 0
    }
    roster.push({
      id:                d.id,
      fullName:          d.fullName,
      status:            d.status,
      rating,
      trips:             dTrips.length,
      tonnes:            toTonnes(lifetimeKg),
      mileageKm:         Math.round(lifetimeKm),
      fuelTheftCases:    dThefts.length,
      overspeedingCases: overspeedByDriver.get(d.id) ?? 0,
    })

    // ── Detail: trailing window anchored to the driver's latest trip ──
    const to = dTrips.length ? dTrips[dTrips.length - 1].beganAt : new Date()
    const from = new Date(to.getTime() - days * 86_400_000)
    const windowTrips = dTrips.filter(t => t.beganAt >= from && t.beganAt <= to)

    let totalKm = 0, totalKg = 0, totalSeconds = 0
    const byDayMap = new Map<string, { tonnes: number; mileageKm: number }>()
    let heaviest: { kg: number; date: Date; route: string } | null = null

    for (const t of windowTrips) {
      const kg = t.cargoManifest?.arrivalWeightKg ?? 0
      const km = t.mileageKm ?? 0
      totalKm += km; totalKg += kg; totalSeconds += t.durationSeconds ?? 0

      const dayKey = t.beganAt.toISOString().slice(0, 10)
      const day = byDayMap.get(dayKey) ?? { tonnes: 0, mileageKm: 0 }
      day.tonnes += kg / 1000; day.mileageKm += km; byDayMap.set(dayKey, day)

      if (kg > 0 && (!heaviest || kg > heaviest.kg)) {
        const route =
          t.route?.name ??
          (t.route ? `${t.route.originName} → ${t.route.destinationName}` : null) ??
          t.finalLocation ?? 'Unknown route'
        heaviest = { kg, date: t.beganAt, route }
      }
    }

    // Windowed overspeeding: alerts that fired during one of the driver's
    // windowed trips (each alert counted once).
    const windowVehicleIds = [...new Set(windowTrips.map(t => t.vehicleId))]
    let overspeedingCases = 0
    for (const vid of windowVehicleIds) {
      for (const a of alerts) {
        if (a.vehicleId !== vid) continue
        if (a.triggeredAt < from || a.triggeredAt > to) continue
        if (windowTrips.some(t => t.vehicleId === vid && a.triggeredAt >= t.beganAt && t.endedAt != null && a.triggeredAt <= t.endedAt)) {
          overspeedingCases += 1
        }
      }
    }

    details[d.id] = {
      driver: {
        id:            d.id,
        fullName:      d.fullName,
        status:        d.status,
        rating,
        licenceNumber: d.licenceNumber,
        employeeId:    d.employeeId,
      },
      totals: {
        trips:             windowTrips.length,
        mileageKm:         Math.round(totalKm),
        tonnes:            toTonnes(totalKg),
        hoursOnRoad:       Math.round(totalSeconds / 360) / 10, // seconds → hours, 1 dp
        fuelTheftCases:    dThefts.filter(at => at >= from && at <= to).length,
        overspeedingCases,
        windowDays:        days,
      },
      heaviestLoad: heaviest && {
        tonnes: toTonnes(heaviest.kg),
        date:   heaviest.date.toISOString().slice(0, 10),
        route:  heaviest.route,
      },
      byDay: [...byDayMap]
        .map(([day, v]) => ({ day, tonnes: Math.round(v.tonnes * 10) / 10, mileageKm: Math.round(v.mileageKm) }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    }
  }

  roster.sort((a, b) => b.tonnes - a.tonnes)
  return { windowDays: days, generatedAt: new Date().toISOString(), drivers: roster, details }
}

/**
 * Deep analytics for one driver over the trailing `days` window: mileage, tonnes
 * ferried, hours on the road, fuel-theft cases, overspeeding trips (trips whose
 * peak speed exceeded the limit), rating, the single heaviest load (with its
 * date + route), and a per-day tonnes/mileage series for the trend charts. All
 * from persisted Trip + CargoManifest + FuelTheft rows.
 */
export async function driverAnalytics(orgId: string, driverId: string, q: DeliveriesQuery) {
  // Anchor the window to the driver's latest trip (the sim clock runs ahead of
  // wall-clock time), mirroring deliveriesAnalytics.
  let to = q.to
  if (!to) {
    const latest = await prisma.trip.aggregate({
      where: { driverId, vehicle: { organisationId: orgId } },
      _max:  { beganAt: true },
    })
    to = latest._max.beganAt ?? new Date()
  }
  const from = new Date(to.getTime() - q.days * 86_400_000)

  const driver = await prisma.user.findFirst({
    where:  { id: driverId, organisationId: orgId },
    select: { id: true, fullName: true, status: true, driverRatingScore: true, licenceNumber: true, employeeId: true },
  })

  const trips = await prisma.trip.findMany({
    where:  { driverId, vehicle: { organisationId: orgId }, beganAt: { gte: from, lte: to } },
    select: {
      vehicleId: true, beganAt: true, endedAt: true, mileageKm: true, durationSeconds: true,
      maxSpeedKmh: true, finalLocation: true,
      route:         { select: { name: true, originName: true, destinationName: true } },
      cargoManifest: { select: { arrivalWeightKg: true } },
    },
    orderBy: { beganAt: 'asc' },
  })

  let totalKm = 0, totalKg = 0, totalSeconds = 0
  const byDayMap = new Map<string, { tonnes: number; mileageKm: number }>()
  let heaviest: { kg: number; date: Date; route: string } | null = null

  for (const t of trips) {
    const kg = t.cargoManifest?.arrivalWeightKg ?? 0
    const km = t.mileageKm ?? 0
    totalKm += km; totalKg += kg; totalSeconds += t.durationSeconds ?? 0

    const dayKey = t.beganAt.toISOString().slice(0, 10)
    const d = byDayMap.get(dayKey) ?? { tonnes: 0, mileageKm: 0 }
    d.tonnes += kg / 1000; d.mileageKm += km; byDayMap.set(dayKey, d)

    if (kg > 0 && (!heaviest || kg > heaviest.kg)) {
      const route =
        t.route?.name ??
        (t.route ? `${t.route.originName} → ${t.route.destinationName}` : null) ??
        t.finalLocation ?? 'Unknown route'
      heaviest = { kg, date: t.beganAt, route }
    }
  }

  const fuelTheftCases = await prisma.fuelTheft.count({
    where: { driverId, vehicle: { organisationId: orgId }, beganAt: { gte: from, lte: to } },
  })

  const vehicleIds = [...new Set(trips.map(t => t.vehicleId))]
  let overspeedingCases = 0
  if (vehicleIds.length > 0) {
    const alerts = await prisma.vehicleAlert.findMany({
      where:  { organisationId: orgId, vehicleId: { in: vehicleIds }, type: 'overspeeding', triggeredAt: { gte: from, lte: to } },
      select: { vehicleId: true, triggeredAt: true },
    })
    overspeedingCases = alerts.filter(a =>
      trips.some(t => t.vehicleId === a.vehicleId && a.triggeredAt >= t.beganAt && a.triggeredAt <= t.endedAt),
    ).length
  }

  return {
    driver: driver && {
      id:            driver.id,
      fullName:      driver.fullName,
      status:        driver.status,
      rating:        Math.round((driver.driverRatingScore ?? 0) * 10) / 10,
      licenceNumber: driver.licenceNumber,
      employeeId:    driver.employeeId,
    },
    totals: {
      trips:             trips.length,
      mileageKm:         Math.round(totalKm),
      tonnes:            toTonnes(totalKg),
      hoursOnRoad:       Math.round(totalSeconds / 360) / 10, // seconds → hours, 1 dp
      fuelTheftCases,
      overspeedingCases,
      windowDays:        q.days,
    },
    heaviestLoad: heaviest && {
      tonnes: toTonnes(heaviest.kg),
      date:   heaviest.date.toISOString().slice(0, 10),
      route:  heaviest.route,
    },
    byDay: [...byDayMap]
      .map(([day, v]) => ({ day, tonnes: Math.round(v.tonnes * 10) / 10, mileageKm: Math.round(v.mileageKm) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  }
}

