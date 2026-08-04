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

// Fleet operating timezone — analytics buckets by KENYAN calendar day, not UTC
// day (a 01:00 EAT trip belongs to that day, not the previous UTC one). Kenya
// observes no DST, so the fixed offset and whole-day ms arithmetic are safe.
const FLEET_TZ_OFFSET = '+03:00'
const fleetDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' })
/** YYYY-MM-DD of `d` in the fleet's timezone. */
const fleetDayKey = (d: Date) => fleetDayFmt.format(d)

/**
 * Deliveries dashboard aggregate over the trailing `days` window: everything
 * derived from the real persisted Trip + CargoManifest + VehicleAlert rows —
 * products ferried, busiest days, depots served (most→least), timely vs
 * interrupted deliveries, and distance covered (with per-day/week/month means).
 */
export async function deliveriesAnalytics(orgId: string, q: DeliveriesQuery) {
  // The window is exactly `q.days` CALENDAR days in the fleet's timezone, the
  // newest being the current day — 7d = today + the 6 days before it. The old
  // rolling `to − N×24h` timestamp range touched N+1 calendar dates (an "8
  // active days" 7d filter), and quiet days were dropped entirely (a "5 active
  // days" one); now every window day is returned, zeroed when nothing ran.
  //
  // Anchor: the LATER of wall-clock now and the newest trip — the sim clock
  // can run ahead of real time, and anchoring to plain `new Date()` would chop
  // the sim's most recent days; a fleet that's been idle still anchors to
  // today so the window ends on the current day.
  let anchor = q.to ?? new Date()
  if (!q.to) {
    const latest = await prisma.trip.aggregate({
      where: { vehicle: { organisationId: orgId } },
      _max:  { beganAt: true },
    })
    if (latest._max.beganAt && latest._max.beganAt > anchor) anchor = latest._max.beganAt
  }
  const anchorDayStart = new Date(`${fleetDayKey(anchor)}T00:00:00${FLEET_TZ_OFFSET}`)
  const from = new Date(anchorDayStart.getTime() - (q.days - 1) * 86_400_000)
  const to   = new Date(anchorDayStart.getTime() + 86_400_000 - 1)
  // Every calendar day in the window, oldest→newest (Kenya has no DST, so
  // whole-day arithmetic in ms is safe).
  const windowDays = Array.from({ length: q.days }, (_, i) =>
    fleetDayKey(new Date(from.getTime() + i * 86_400_000)))

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
    const dayKey  = fleetDayKey(t.beganAt)

    const expectedHours = t.avgSpeedKmh && t.avgSpeedKmh > 0 && km ? km / t.avgSpeedKmh : null
    const isInterrupted = expectedHours != null && t.durationSeconds / 3600 > expectedHours * INTERRUPTED_RATIO
    if (isInterrupted) interrupted += 1

    bump(products, product, kg)
    bump(depots, depot, kg)
    const d = byDay.get(dayKey) ?? { trips: 0, kg: 0, km: 0, timely: 0 }
    d.trips += 1; d.kg += kg; d.km += km; if (!isInterrupted) d.timely += 1; byDay.set(dayKey, d)
    // Weekday of the fleet-timezone day (dayKey parses as UTC midnight).
    byWeekday[new Date(`${dayKey}T00:00:00Z`).getUTCDay()] += 1
    totalKm += km; totalKg += kg
  }

  const t1 = (kg: number) => Math.round(kg / 100) / 10 // kg → tonnes, 1 dp
  // Days that actually saw trips — byDay only accumulates active days; the
  // zero-filled series below is presentation, not activity.
  const activeDays = byDay.size
  const perDayKm   = totalKm / (activeDays || 1)

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
    // One entry per window day, oldest→newest, zeroed where nothing ran — the
    // charts always plot exactly `windowDays` days.
    byDay: windowDays.map((day) => {
      const v = byDay.get(day)
      return { day, trips: v?.trips ?? 0, tonnes: t1(v?.kg ?? 0), distanceKm: Math.round(v?.km ?? 0), timely: v?.timely ?? 0 }
    }),
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

/**
 * Fuel actually PUT IN and actually LOST over the trailing `days` window, from
 * the FuelFilling + FuelTheft ledger the Wialon fuel sync persists.
 *
 * Why not `fuelEfficiency` above: that one sums `VehicleTelemetry.fuelUsedMl`,
 * a channel this fleet's trackers never populate — it returns [] in production.
 * The ledger is the only fuel source with real rows in it, and it is the one an
 * operator can reconcile against receipts.
 *
 * Quantities only, deliberately: no money. Costing needs a price, no price is
 * persisted anywhere, and mixing one in here would put the price in the warm
 * cache key. See fuel-pricing.ts — the controller prices this payload on the
 * way out, so the cached aggregate is shared by every caller whatever rate
 * they asked for.
 */
export async function fuelConsumption(orgId: string, q: DeliveriesQuery) {
  // Window and anchoring follow deliveriesAnalytics exactly — same calendar
  // days in the fleet's timezone, same "later of now and the newest row"
  // anchor, so the two dashboards can never disagree about what "30 days" is.
  let anchor = q.to ?? new Date()
  if (!q.to) {
    const latest = await prisma.fuelFilling.aggregate({
      where: { vehicle: { organisationId: orgId } },
      _max:  { filledAt: true },
    })
    if (latest._max.filledAt && latest._max.filledAt > anchor) anchor = latest._max.filledAt
  }
  const anchorDayStart = new Date(`${fleetDayKey(anchor)}T00:00:00${FLEET_TZ_OFFSET}`)
  const from = new Date(anchorDayStart.getTime() - (q.days - 1) * 86_400_000)
  const to   = new Date(anchorDayStart.getTime() + 86_400_000 - 1)
  const windowDays = Array.from({ length: q.days }, (_, i) =>
    fleetDayKey(new Date(from.getTime() + i * 86_400_000)))

  const vehicleSelect = { select: { registrationPlate: true, name: true } }
  const [fillings, thefts] = await Promise.all([
    prisma.fuelFilling.findMany({
      where:  { vehicle: { organisationId: orgId }, filledAt: { gte: from, lte: to } },
      select: { vehicleId: true, filledAt: true, filledMl: true, vehicle: vehicleSelect },
      orderBy: { filledAt: 'asc' },
    }),
    // A drain is dated by when it BEGAN, not when the probe caught it: a theft
    // that starts at 23:50 and is detected at 00:05 belongs to the night it
    // happened, which is the day an operator will go looking for it.
    prisma.fuelTheft.findMany({
      where:  { vehicle: { organisationId: orgId }, beganAt: { gte: from, lte: to } },
      select: { vehicleId: true, beganAt: true, stolenMl: true, vehicle: vehicleSelect },
      orderBy: { beganAt: 'asc' },
    }),
  ])

  interface Bucket { filledMl: number; stolenMl: number; fillings: number; thefts: number }
  const empty = (): Bucket => ({ filledMl: 0, stolenMl: 0, fillings: 0, thefts: 0 })
  const byDay     = new Map<string, Bucket>()
  const byVehicle = new Map<string, Bucket & { registrationPlate: string | null; name: string | null }>()

  const vehicleBucket = (id: string, v: { registrationPlate: string | null; name: string | null }) => {
    let e = byVehicle.get(id)
    if (!e) { e = { ...empty(), registrationPlate: v.registrationPlate, name: v.name }; byVehicle.set(id, e) }
    return e
  }
  const dayBucket = (key: string) => {
    let e = byDay.get(key)
    if (!e) { e = empty(); byDay.set(key, e) }
    return e
  }

  let totalFilledMl = 0, totalStolenMl = 0
  for (const f of fillings) {
    const d = dayBucket(fleetDayKey(f.filledAt)); d.filledMl += f.filledMl; d.fillings += 1
    const v = vehicleBucket(f.vehicleId, f.vehicle); v.filledMl += f.filledMl; v.fillings += 1
    totalFilledMl += f.filledMl
  }
  for (const t of thefts) {
    const d = dayBucket(fleetDayKey(t.beganAt)); d.stolenMl += t.stolenMl; d.thefts += 1
    const v = vehicleBucket(t.vehicleId, t.vehicle); v.stolenMl += t.stolenMl; v.thefts += 1
    totalStolenMl += t.stolenMl
  }

  // Days that saw ANY fuel movement — the zero-filled series below is
  // presentation, so a per-day average must not divide by quiet days.
  const activeDays = byDay.size

  return {
    totals: {
      filledMl:   totalFilledMl,
      stolenMl:   totalStolenMl,
      fillings:   fillings.length,
      thefts:     thefts.length,
      windowDays: q.days,
      activeDays,
    },
    // One entry per window day, oldest→newest, zeroed where no fuel moved.
    byDay: windowDays.map((day) => {
      const v = byDay.get(day) ?? empty()
      return { day, filledMl: v.filledMl, stolenMl: v.stolenMl, fillings: v.fillings, thefts: v.thefts }
    }),
    // Thirstiest first — that is the order the operator wants to read.
    byVehicle: [...byVehicle].map(([vehicleId, v]) => ({
      vehicleId,
      registrationPlate: v.registrationPlate,
      name:              v.name,
      filledMl:          v.filledMl,
      stolenMl:          v.stolenMl,
      fillings:          v.fillings,
      thefts:            v.thefts,
    })).sort((a, b) => b.filledMl - a.filledMl),
  }
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

// ── conduct-based suspension policy ─────────────────────────────────────────
// SUSPENDED is COMPUTED, never read from the seeded employment column: a
// driver is suspended only when their lifetime record crosses BOTH lines at
// once — at least SUSPEND_THEFT_CASES fuel-theft cases AND overspeeding on at
// least SUSPEND_OVERSPEED_RATE of their trips (the rate is what matters — 30
// cases per 100 trips is the same offence as 3 in 10). Either offence alone
// is not enough. Hard employment states (TERMINATED, …) still pass through;
// a seeded SUSPENDED that the record doesn't justify reads as ACTIVE.
const SUSPEND_THEFT_CASES    = 2
const SUSPEND_OVERSPEED_RATE = 0.30

function conductStatus(dbStatus: string, trips: number, fuelTheftCases: number, overspeedingCases: number): string {
  if (dbStatus !== 'ACTIVE' && dbStatus !== 'SUSPENDED') return dbStatus
  const overspeedRate = trips > 0 ? overspeedingCases / trips : 0
  return fuelTheftCases >= SUSPEND_THEFT_CASES && overspeedRate >= SUSPEND_OVERSPEED_RATE
    ? 'SUSPENDED'
    : 'ACTIVE'
}

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
 * The roster is the org's DRIVER REGISTRY — every user holding a driver role,
 * synced from the RaiFactorySuite API by sync:drivers. Lifetime aggregates
 * (trips, tonnes, mileage, theft/overspeed cases) come from real Trip +
 * CargoManifest + FuelTheft + VehicleAlert rows, so a driver with no recorded
 * activity yet reports honest zeroes; each driver's detail covers a trailing
 * `days` window anchored to that driver's latest trip.
 *
 * The DB round trip is the expensive part (remote pooler), so everything is
 * fetched in 3 parallel queries after the roster lookup and aggregated in JS
 * — this function is also what the drivers-overview cache warms so requests
 * never wait on the database.
 */
export async function driversOverview(orgId: string, days: number): Promise<DriversOverview> {
  // The roster is the org's DRIVER REGISTRY (synced from RaiFactorySuite by
  // sync:drivers), not just whoever happens to be out on a dispatch right now
  // — a driver between dispatches is still on the workforce. Employment
  // standing rides along on `status`, which the grid badges.
  const userSelect = {
    id: true, fullName: true, status: true, driverRatingScore: true,
    licenceNumber: true, employeeId: true,
  } as const
  const drivers = await prisma.user.findMany({
    where: {
      organisationId: orgId,
      deletedAt: null,
      userRoles: { some: { revokedAt: null, role: { slug: { in: DRIVER_ROLE_SLUGS } } } },
    },
    select:  userSelect,
    orderBy: { fullName: 'asc' },
  })
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

  // Lifetime overspeeding cases per driver: a case is a TRIP during which at
  // least one overspeeding alert fired (matching vehicle + time window) — one
  // trip counts once however many alerts it raised, so the count is bounded
  // by trips and `cases / trips` reads as "share of trips oversped" (the
  // suspension policy's 30-per-100-trips line).
  const overspeedTripsByDriver = new Map<string, Set<TripRow>>()
  for (const a of alerts) {
    const hit = (tripsByVehicle.get(a.vehicleId) ?? []).find(t =>
      t.driverId && a.triggeredAt >= t.beganAt && (t.endedAt == null || a.triggeredAt <= t.endedAt),
    )
    if (hit?.driverId) {
      const set = overspeedTripsByDriver.get(hit.driverId) ?? new Set<TripRow>()
      set.add(hit); overspeedTripsByDriver.set(hit.driverId, set)
    }
  }

  const roster: DriverRosterRow[] = []
  const details: Record<string, DriverDetail> = {}

  for (const d of drivers) {
    const dTrips = tripsByDriver.get(d.id) ?? []
    const dThefts = theftsByDriver.get(d.id) ?? []
    const rating = Math.floor((d.driverRatingScore ?? 0) * 10) / 10

    // ── Roster row: lifetime aggregates ──
    let lifetimeKm = 0, lifetimeKg = 0
    for (const t of dTrips) {
      lifetimeKm += t.mileageKm ?? 0
      lifetimeKg += t.cargoManifest?.arrivalWeightKg ?? 0
    }
    // Employment status escalated by lifetime conduct (see conductStatus) —
    // the roster badge and the detail header both use this derived value.
    const lifetimeOverspeed = overspeedTripsByDriver.get(d.id)?.size ?? 0
    const status = conductStatus(d.status, dTrips.length, dThefts.length, lifetimeOverspeed)
    roster.push({
      id:                d.id,
      fullName:          d.fullName,
      status,
      rating,
      trips:             dTrips.length,
      tonnes:            toTonnes(lifetimeKg),
      mileageKm:         Math.round(lifetimeKm),
      fuelTheftCases:    dThefts.length,
      overspeedingCases: lifetimeOverspeed,
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

    // Windowed overspeeding: trips in the window during which at least one
    // alert fired — same one-case-per-trip semantics as the lifetime count.
    const overspeedingCases = windowTrips.filter(t =>
      alerts.some(a =>
        a.vehicleId === t.vehicleId &&
        a.triggeredAt >= t.beganAt &&
        t.endedAt != null && a.triggeredAt <= t.endedAt,
      ),
    ).length

    details[d.id] = {
      driver: {
        id:            d.id,
        fullName:      d.fullName,
        status,        // conduct-derived — matches the roster badge
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
    // One case per TRIP that oversped, not per alert — matches driversOverview.
    overspeedingCases = trips.filter(t =>
      alerts.some(a => a.vehicleId === t.vehicleId && a.triggeredAt >= t.beganAt && a.triggeredAt <= t.endedAt),
    ).length
  }

  return {
    driver: driver && {
      id:            driver.id,
      fullName:      driver.fullName,
      status:        driver.status,
      rating:        Math.floor((driver.driverRatingScore ?? 0) * 10) / 10,
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

