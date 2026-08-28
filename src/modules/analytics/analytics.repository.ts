import { prisma } from '../../lib/prisma.js'
import { getSimFleetVehicleIds } from '../../lib/sim-fleet.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import type { AnalyticsRange, SpeedingQuery, DeliveriesQuery } from './analytics.schema.js'
import { calculateDriverRating } from './driver-rating.js'
import type { FuelEventVerdict } from '../../../generated/prisma/client.js'
import { NO_FUEL_LEFT, NO_FUEL_ARRIVED } from '../fuel/fuel-adjudication.js'
// The one implementation of "was an operator actually told about this". Read
// here rather than re-derived on the client: a second copy of that rule would
// drift from the alerts it is supposed to describe.
import { announces, CAUSE_NO_FUEL_LEFT } from '../fuel/fuel-theft-classifier.js'

// `NO_FUEL_LEFT` (drains) and `NO_FUEL_ARRIVED` (fillings) are imported rather
// than declared here. They interpret a `Verdict`, so they live beside it in
// modules/fuel/fuel-adjudication — and they are a matched pair that must not be
// confused for each other, which is easier to see where both are defined
// together than where one sits in analytics and the other in a report.

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
/**
 * @param vehicleIds when non-null, the only vehicles that count — the
 *   Analytics page's vehicle-type filter, already resolved to ids by
 *   analytics/vehicle-filter. An EMPTY array is a real answer (the operator
 *   picked a category this fleet has none of) and must return zeroes, so the
 *   test is `!= null` and never a truthiness check on `.length`.
 */
export async function deliveriesAnalytics(
  orgId: string, q: DeliveriesQuery, vehicleIds: string[] | null = null,
) {
  // Applied to the anchor as well as to the rows. Anchoring to the fleet's
  // newest trip while counting one category's trips would end the window on a
  // day the chosen machines may not have worked, and the heatmap would open on
  // trailing empty cells that belong to other vehicles.
  const vehicleWhere = vehicleIds == null ? {} : { vehicleId: { in: vehicleIds } }
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
      where: { vehicle: { organisationId: orgId }, ...vehicleWhere },
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
    where:  { vehicle: { organisationId: orgId }, ...vehicleWhere, beganAt: { gte: from, lte: to } },
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
    // Dispatchers type the destination freehand and the casing wanders, so group
    // on the same UPPER(TRIM()) key ai-insight and dispatch.repository use. This
    // was the one place that grouped on the raw string, and it showed: August
    // reported 98 destinations served, with OPAPO and Opapo, OYANI and Oyani,
    // MIYORO and miyoro each counted as two places and their trips split
    // between them.
    const depot   = t.finalLocation?.trim().toUpperCase() || 'Unknown'
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
/** @param vehicleIds see deliveriesAnalytics — same filter, same semantics. */
export async function fuelConsumption(
  orgId: string, q: DeliveriesQuery, vehicleIds: string[] | null = null,
) {
  const vehicleWhere = vehicleIds == null ? {} : { vehicleId: { in: vehicleIds } }
  // Window and anchoring follow deliveriesAnalytics exactly — same calendar
  // days in the fleet's timezone, same "later of now and the newest row"
  // anchor, so the two dashboards can never disagree about what "30 days" is.
  let anchor = q.to ?? new Date()
  if (!q.to) {
    const latest = await prisma.fuelFilling.aggregate({
      where: { vehicle: { organisationId: orgId }, ...vehicleWhere },
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
    // Deliveries that never arrived are excluded — see NO_FUEL_ARRIVED.
    prisma.fuelFilling.findMany({
      where:  {
        vehicle: { organisationId: orgId },
        ...vehicleWhere,
        filledAt: { gte: from, lte: to },
        verdict: { notIn: NO_FUEL_ARRIVED },
      },
      select: { vehicleId: true, filledAt: true, filledMl: true, vehicle: vehicleSelect },
      orderBy: { filledAt: 'asc' },
    }),
    // A drain is dated by when it BEGAN, not when the probe caught it: a theft
    // that starts at 23:50 and is detected at 00:05 belongs to the night it
    // happened, which is the day an operator will go looking for it.
    //
    // Verdicts that are not a loss are excluded — see NO_FUEL_LEFT.
    prisma.fuelTheft.findMany({
      where:  {
        vehicle: { organisationId: orgId },
        ...vehicleWhere,
        beganAt: { gte: from, lte: to },
        verdict: { notIn: NO_FUEL_LEFT },
        // ...and, one level down, the falls whose SHAPE says no fuel left even
        // though the verdict is DRAIN — slosh and settling. See
        // CAUSE_NO_FUEL_LEFT.
        //
        // Written as an explicit OR because `notIn` compiles to SQL `NOT IN`,
        // and `NULL NOT IN (...)` is NULL, not true — so the plain form would
        // have silently dropped every UNJUDGED drain. That is 1,585 rows and
        // 119,731 L, 55% of the figure, removed by a filter meant to take out
        // 54 rows. Absent a cause is not the same as having a disqualifying
        // one, and the query has to say so.
        OR: [
          { drainCause: null },
          { drainCause: { notIn: [...CAUSE_NO_FUEL_LEFT] } },
        ],
      },
      // Wider than the totals need, because the same rows are now returned
      // individually as `drains` — see the note there on why this is the query
      // that has to produce them.
      select: {
        id: true, vehicleId: true, beganAt: true, stolenMl: true,
        initialLocation: true, drainCause: true, causeReason: true,
        verdict: true, fallSeconds: true,
        // The FSL either side of the fall — the tank level the probe actually
        // read at that hour, not a derived figure. Present on 3,271 of 3,271
        // drains over 30 days, and `stolenMl` equals their difference on every
        // one of them, so a reader can check the row's arithmetic on the page.
        initialFuelLevelMl: true, finalFuelLevelMl: true,
        vehicle: vehicleSelect,
      },
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
    /**
     * Every drain behind `totals.stolenMl`, one row each, newest first.
     *
     * From the SAME query the totals are summed from, deliberately. The
     * alternative — the client calling `/fuel/thefts` for the window — filters
     * on its own `verdict` set and its own date bounds, and the moment either
     * drifts the report prints a table that does not add up to the figure
     * printed above it. Here it cannot: a row is in this list if and only if it
     * was counted, so the litres always sum to `totals.stolenMl`.
     *
     * `beganAt`, not `detectedAt` — the ledger dates a drain by when the fuel
     * started leaving, which is the night an operator goes looking for it.
     * `fallSeconds` is the MEASURED duration of the fall where the adjudicator
     * could measure it, and null on rows judged before 2026-08-28. Null is not
     * zero and must not be rendered as one.
     */
    drains: thefts.map(t => ({
      id:                t.id,
      vehicleId:         t.vehicleId,
      registrationPlate: t.vehicle.registrationPlate,
      name:              t.vehicle.name,
      beganAt:           t.beganAt,
      stolenMl:          t.stolenMl,
      // FSL, millilitres. Priced into litres on the way out like everything
      // else — see fuel-pricing.
      levelBeforeMl:     t.initialFuelLevelMl,
      levelAfterMl:      t.finalFuelLevelMl,
      location:          t.initialLocation,
      cause:             t.drainCause,
      causeReason:       t.causeReason,
      verdict:           t.verdict,
      /**
       * Was an operator actually told about this one?
       *
       * Measured over 30 days: 90 of 3,275. The ledger records every fall it
       * cannot explain, and the classifier announces only the few it can stand
       * behind — so a reader who takes the row count as an alert count is out
       * by a factor of thirty-six. Carried per row so the report can say which
       * is which instead of implying they are the same thing.
       */
      announced:         t.drainCause != null
                           && announces({ cause: t.drainCause, reason: t.causeReason ?? '' }),
      fallSeconds:       t.fallSeconds,
    })).sort((a, b) => b.beganAt.getTime() - a.beganAt.getTime()),
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

/**
 * One fuel event pinned to a driver.
 *
 * `attributedBy` is on the record because the two routes are not equally
 * certain: 'record' means the event itself named the driver, 'trip' means we
 * inferred it from the trip running on that vehicle at that instant. Nothing
 * currently writes the former, so every case today is inferred — and a card
 * that shows a suspension-relevant count should be able to say so.
 *
 * `verdict` and `confirmed` travel with it rather than being reduced to a
 * boolean here: whether an event may be called a theft is the adjudicator's
 * decision, and re-deriving that vocabulary in a second place is a second
 * implementation that can drift.
 */
export interface DriverIncident {
  id:      string
  at:      string
  plate:   string | null
  /** Litres the level fell by. */
  litres:  number
  /** How long the fall lasted. A rate, not just a total. */
  minutes: number
  /** Tank level either side of the fall, litres — what to check the gauge against. */
  fromL:   number | null
  toL:     number | null
  where:   string | null
  /** The adjudicator's verdict and its reasoning, passed through unchanged. */
  verdict:         string
  verdictReason:   string | null
  cause:           string | null
  causeReason:     string | null
  causeConfidence: number | null
  attributedBy: 'record' | 'trip'
  /**
   * Whether this event counts toward the driver's case total.
   *
   * True only for SIPHON. Every other cause is either normal consumption, a
   * measurement artefact, or unexplained — and unexplained is explicitly not
   * theft. Events that do not count are still carried, because an operator
   * looking at a driver wants to see what the unit did on their watch; they
   * simply do not add to a number that can end an employment.
   */
  countsAgainstDriver: boolean
}

export interface DriverOverspeed {
  id:    string
  at:    string
  plate: string | null
  route: string | null
  attributedBy: 'trip'
}

export interface DriverDetail {
  driver: {
    id: string; fullName: string; status: string; rating: number
    licenceNumber: string | null; employeeId: string | null
  }
  totals: {
    trips: number; mileageKm: number; tonnes: number; hoursOnRoad: number
    fuelTheftCases: number; overspeedingCases: number; windowDays: number
    /** Fuel events on the unit while they drove it, chargeable or not. */
    fuelEventsSeen: number
  }
  heaviestLoad: { tonnes: number; date: string; route: string } | null
  byDay: { day: string; tonnes: number; mileageKm: number }[]
  /** Every case behind the two counts above, newest first. */
  incidents: { thefts: DriverIncident[]; overspeeds: DriverOverspeed[] }
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
    // REDISTRIBUTION excluded — see fuelConsumption. It matters more here than
    // anywhere: conductStatus can SUSPEND a driver on two fuel-theft cases, and
    // roughly half of the raw claims are fuel that never left the tank.
    // Suspending someone over a slope is the worst thing this data can do.
    // Selected by ORGANISATION, not by driverId.
    //
    // `driverId` on this table is populated by nothing: measured 2026-08-21,
    // all 1,256 of SUKARI's fuel-theft rows carry null, so filtering on it
    // returned an empty set and every driver's fuel-theft count has been zero
    // since the column was added. The driver is resolved below the way
    // overspeeding already resolves it — from the trip that was running on that
    // vehicle at that moment.
    prisma.fuelTheft.findMany({
      where:  {
        vehicle: { organisationId: orgId },
        verdict: { notIn: NO_FUEL_LEFT },
      },
      select: {
        id: true, driverId: true, vehicleId: true,
        beganAt: true, detectedAt: true, fallSeconds: true,
        stolenMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true,
        initialLocation: true,
        verdict: true, verdictReason: true,
        drainCause: true, causeConfidence: true, causeReason: true,
        vehicle: { select: { registrationPlate: true } },
      },
      orderBy: { beganAt: 'desc' },
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

  /**
   * Fuel events, pinned to whoever was driving the unit at the time.
   *
   * An explicit `driverId` wins where one exists; otherwise the driver is the
   * one on the trip covering that instant on that vehicle — the same resolution
   * overspeeding uses ten lines down, and the only one available, since nothing
   * writes the column.
   *
   * An event nobody was driving for stays unattributed rather than being
   * assigned to the vehicle's usual driver. Measured on SUKARI, 176 of 1,256
   * events fall inside a trip; the other 1,080 happened with no trip running,
   * and guessing an owner for those would put a suspension case on somebody who
   * was not there.
   */
  const theftsByDriver = new Map<string, DriverIncident[]>()
  for (const th of thefts) {
    const driverId = th.driverId ?? (tripsByVehicle.get(th.vehicleId) ?? []).find(t =>
      t.driverId && th.beganAt >= t.beganAt && (t.endedAt == null || th.beganAt <= t.endedAt),
    )?.driverId
    if (!driverId) continue

    const arr = theftsByDriver.get(driverId) ?? []
    arr.push({
      id:       th.id,
      at:       th.beganAt.toISOString(),
      plate:    th.vehicle?.registrationPlate ?? null,
      litres:   Math.round((th.stolenMl / 1000) * 10) / 10,
      // Minutes the level was falling. 47 L over four hours and 47 L over four
      // minutes are different events with the same headline, so the rate is
      // carried rather than left to be inferred from a total.
      //
      // The MEASURED fall where we have it, falling back to the provider's
      // window otherwise. Those are not the same quantity and the difference is
      // large: `detectedAt - beganAt` is the window Wialon reports, and
      // PLATEAU_TOLERANCE exists precisely because a machine sitting full for
      // half an hour and then losing fuel in four minutes is reported as a
      // 34-minute fall. Measured 2026-08-16, parked "falls" had a median
      // duration of 33 minutes, most of it flat — so this column was dividing
      // real rates by eight and turning siphons into trickles.
      //
      // Null fallSeconds means the row predates 2026-08-28 or its fall was not
      // measurable. The provider window is then the only figure available, and
      // it is better than nothing as long as nobody mistakes it for the other.
      minutes:  th.fallSeconds != null
        ? Math.max(1, Math.round(th.fallSeconds / 60))
        : Math.round((th.detectedAt.getTime() - th.beganAt.getTime()) / 60_000),
      fromL:    th.initialFuelLevelMl == null ? null : Math.round(th.initialFuelLevelMl / 100) / 10,
      toL:      th.finalFuelLevelMl   == null ? null : Math.round(th.finalFuelLevelMl / 100) / 10,
      where:    th.initialLocation ?? null,
      // The adjudicator's own words, passed through. Whether an event may be
      // called a theft is its decision; re-deriving that vocabulary here would
      // be a second implementation of a rule that already exists.
      verdict:       th.verdict,
      verdictReason: th.verdictReason ?? null,
      cause:         th.drainCause ?? null,
      causeReason:   th.causeReason ?? null,
      causeConfidence: th.causeConfidence ?? null,
      attributedBy: th.driverId ? 'record' : 'trip',
      // Whether this event may be counted AGAINST the driver.
      //
      // Only a siphon may. The schema says so where the enum is declared:
      // SIPHON is "the only cause that may be described as possible theft",
      // UNEXPLAINED_BURN is "announced, but NEVER as theft", ENGINE_BURN is
      // "not an incident", SLOSH is "the reading, not the tank".
      //
      // This is not pedantry about wording. conductStatus SUSPENDS a driver at
      // two fuel-theft cases, and of the 133 events that fall inside a trip on
      // SUKARI, not one is a siphon — they are 92 unadjudicated, 14
      // indeterminate, 12 unexplained burn, 8 high burn, 4 engine burn and 3
      // slosh. Counting those would suspend drivers for their engine using
      // fuel.
      countsAgainstDriver: th.drainCause === 'SIPHON',
    })
    theftsByDriver.set(driverId, arr)
  }

  // Lifetime overspeeding cases per driver: a case is a TRIP during which at
  // least one overspeeding alert fired (matching vehicle + time window) — one
  // trip counts once however many alerts it raised, so the count is bounded
  // by trips and `cases / trips` reads as "share of trips oversped" (the
  // suspension policy's 30-per-100-trips line).
  const overspeedTripsByDriver = new Map<string, Set<TripRow>>()
  const overspeedsByDriver = new Map<string, DriverOverspeed[]>()
  const plateByVehicle = new Map(
    thefts.map(t => [t.vehicleId, t.vehicle?.registrationPlate ?? null]),
  )
  for (const a of alerts) {
    const hit = (tripsByVehicle.get(a.vehicleId) ?? []).find(t =>
      t.driverId && a.triggeredAt >= t.beganAt && (t.endedAt == null || a.triggeredAt <= t.endedAt),
    )
    if (hit?.driverId) {
      const set = overspeedTripsByDriver.get(hit.driverId) ?? new Set<TripRow>()
      set.add(hit); overspeedTripsByDriver.set(hit.driverId, set)

      // The alerts themselves, for the case list. One trip still counts once
      // toward the rate above; this is the evidence behind that one.
      const arr = overspeedsByDriver.get(hit.driverId) ?? []
      arr.push({
        id:        `${a.vehicleId}-${a.triggeredAt.getTime()}`,
        at:        a.triggeredAt.toISOString(),
        plate:     plateByVehicle.get(a.vehicleId) ?? null,
        route:     hit.route?.name ?? null,
        attributedBy: 'trip',
      })
      overspeedsByDriver.set(hit.driverId, arr)
    }
  }

  const roster: DriverRosterRow[] = []
  const details: Record<string, DriverDetail> = {}

  for (const d of drivers) {
    const dTrips = tripsByDriver.get(d.id) ?? []
    const dThefts = theftsByDriver.get(d.id) ?? []
    // Only the siphons count against them — see countsAgainstDriver.
    const chargeable = dThefts.filter(i => i.countsAgainstDriver).length
    const lifetimeOverspeed = overspeedTripsByDriver.get(d.id)?.size ?? 0
    let lifetimeKm = 0, lifetimeKg = 0
    for (const t of dTrips) {
      lifetimeKm += t.mileageKm ?? 0
      lifetimeKg += t.cargoManifest?.arrivalWeightKg ?? 0
    }

    const latestTripAt = dTrips.reduce<Date | null>((latest, t) => {
      if (!latest || t.beganAt > latest) return t.beganAt
      return latest
    }, null)
    const daysSinceLastTrip = latestTripAt ? Math.floor((Date.now() - latestTripAt.getTime()) / 86_400_000) : 999

    const ratingResult = calculateDriverRating({
      baseScore: d.driverRatingScore ?? 5,
      trips: dTrips.length,
      mileageKm: lifetimeKm,
      tonnes: toTonnes(lifetimeKg),
      incentiveBonus: 0,
      fuelTheftCases: chargeable,
      overspeedingCases: lifetimeOverspeed,
      daysSinceLastTrip,
    })
    const rating = ratingResult.rating

    // ── Roster row: lifetime aggregates ──
    // Employment status escalated by lifetime conduct (see conductStatus) —
    // the roster badge and the detail header both use this derived value.
    const status = conductStatus(d.status, dTrips.length, chargeable, lifetimeOverspeed)
    roster.push({
      id:                d.id,
      fullName:          d.fullName,
      status,
      rating,
      trips:             dTrips.length,
      tonnes:            toTonnes(lifetimeKg),
      mileageKm:         Math.round(lifetimeKm),
      fuelTheftCases:    dThefts.filter(i => i.countsAgainstDriver).length,
      overspeedingCases: lifetimeOverspeed,
    })

    // ── Detail: trailing window anchored to the driver's latest trip ──
    const to = dTrips.length ? dTrips[dTrips.length - 1].beganAt : new Date()
    const from = new Date(to.getTime() - days * 86_400_000)
    const windowTrips = dTrips.filter(t => t.beganAt >= from && t.beganAt <= to)
    const windowThefts = dThefts.filter(i => {
      const at = new Date(i.at)
      return at >= from && at <= to
    })

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
        fuelTheftCases:    windowThefts.filter(i => i.countsAgainstDriver).length,
        /** Everything on the unit during their trips, chargeable or not. */
        fuelEventsSeen:    windowThefts.length,
        overspeedingCases,
        windowDays:        days,
      },
      // The cases behind the two counts, newest first. Scoped to the same
      // window the counts use, so a card cannot list five events under a
      // headline of three.
      incidents: {
        thefts:     windowThefts,
        overspeeds: (overspeedsByDriver.get(d.id) ?? [])
          .filter(o => new Date(o.at) >= from && new Date(o.at) <= to),
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
    // Same exclusion as driversOverview — a redistribution is not a case
    // against the driver.
    where: {
      driverId, vehicle: { organisationId: orgId },
      beganAt: { gte: from, lte: to },
      verdict: { notIn: NO_FUEL_LEFT },
    },
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

  const finalDriverRating = driver
    ? calculateDriverRating({
        baseScore: driver.driverRatingScore ?? 5,
        trips: trips.length,
        mileageKm: trips.reduce((sum, t) => sum + (t.mileageKm ?? 0), 0),
        tonnes: toTonnes(trips.reduce((sum, t) => sum + (t.cargoManifest?.arrivalWeightKg ?? 0), 0)),
        incentiveBonus: 0,
        fuelTheftCases,
        overspeedingCases,
        daysSinceLastTrip: trips.length > 0 ? Math.floor((Date.now() - trips[trips.length - 1].beganAt.getTime()) / 86_400_000) : 999,
      })
    : null

  return {
    driver: driver && {
      id:            driver.id,
      fullName:      driver.fullName,
      status:        driver.status,
      rating:        finalDriverRating?.rating ?? 0,
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


/**
 * TODAY on the ground — the operational figures a duty manager reads mid-shift.
 *
 * A DIFFERENT WINDOW from everything else in this file. The rest of the
 * Analytics page is month-to-date; this is the fleet day in progress, from
 * local midnight (fleetDayStart — Ndhiwa's midnight, not UTC's) to now. The
 * caller is expected to label it as such, because a "48 dispatched" that means
 * today sitting beside a "331 completed trips" that means the month is exactly
 * how a card lies without a single wrong number in it.
 *
 * DEPARTURE IS THE SIGN-OUT, not the gate crossing. This card used to count
 * only departures MEASURED off the vehicle's own fixes (lib/yard-departure),
 * and on a fleet where most units have no tracker that is a census of the
 * trackers, not of the yard: measured 2026-08-05, 55 tractors were signed out
 * before 06:00 and the card said 5. Of those 55, 33 are on vehicles with no
 * Wialon unit bound at all (they carry the RaiFactorySuite UUID as `deviceId`
 * and have never produced a fix), 7 had a tracker that stayed silent, and of
 * the 15 that did report only 5 cleared the barrier before the hour — the rest
 * genuinely rolled later. The yard signs a vehicle out; that is the record the
 * operator keeps and the one the factory's own books show, so it is the record
 * this card counts. Where telemetry DID watch the barrier we keep the measured
 * time beside the row (`gateAt`) rather than in place of it — it is the answer
 * to "how long did it then stand there", not to "did it go".
 *
 * WHAT IS DELIBERATELY NOT HERE, because the live fleet has no data behind it:
 *
 *   · FUEL COST SPLIT BY FUEL TYPE. Nothing records a fuel type — not on
 *     FuelFilling, not on Vehicle, nowhere in the schema — and cost is not
 *     recorded either: it is litres × env.FUEL_PRICE_PER_LITRE, ONE configured
 *     rate (see fuel-pricing.ts). A per-type split would be the same total cut
 *     by a column that does not exist.
 *   · VEHICLES DISPATCHED PER WEIGHBRIDGE. Dispatch destinations are cane
 *     collection zones typed freehand by the dispatcher — 61 distinct names on
 *     SUKARI (NYAONDO, OPAPO, WICH DHWAO …) and not one weighbridge among them.
 *     Weigh-in/weigh-out events arrive with the RaiFactorySuite weighbridge
 *     feed, which is why the Weighbridges tab is still an empty state.
 *   · A DRIVER VIOLATIONS LIST. Measured 2026-08-05 on SUKARI: the VehicleAlert
 *     table is empty, GeofenceViolation returns nothing over 30 days, every
 *     FuelTheft row has driverId null, and drivers/overview reports 0
 *     overspeeding and 0 theft cases for all 549 drivers. The only evidence of
 *     a violation on this fleet is raw telemetry over 80 km/h
 *     (speedingEvents above), which carries a vehicle and a time but no driver.
 *     Attributing those to the open dispatch's driverName is derivable and may
 *     be worth doing — but it is an inference, and it needs to be built and
 *     validated deliberately rather than smuggled in behind a count.
 */
/** @param vehicleIds see deliveriesAnalytics — same filter, same semantics. */
export async function operationsToday(orgId: string, vehicleIds: string[] | null = null) {
  const dayStart = fleetDayStart()
  const now = new Date()
  // Two shapes of the same filter: `vehicleId` for rows that carry one, and an
  // `id` predicate for the vehicle registry itself.
  const vehicleWhere   = vehicleIds == null ? {} : { vehicleId: { in: vehicleIds } }
  const registryWhere  = vehicleIds == null ? {} : { id: { in: vehicleIds } }

  const [fleet, fillings, tractorDispatches, truckDispatches, unresolvedDispatches] = await Promise.all([
    // Registry state, not connectivity. `isActive` is what the provider still
    // lists; ONLINE/OFFLINE is the poller's verdict and lives on the decorated
    // snapshot, which this query has no business reaching for.
    prisma.vehicle.groupBy({
      by:      ['vehicleType'],
      where:   { organisationId: orgId, isActive: true, ...registryWhere },
      _count:  { _all: true },
    }),
    // Measured litres off the fuel probes, same ledger the month card reads —
    // just clamped to the day so it is a RUNNING total rather than a period one.
    prisma.fuelFilling.findMany({
      where:  {
        vehicle: { organisationId: orgId }, ...vehicleWhere, filledAt: { gte: dayStart },
        // Deliveries that never arrived are excluded — see NO_FUEL_ARRIVED.
        verdict: { notIn: NO_FUEL_ARRIVED },
      },
      select: { filledMl: true, filledAt: true },
    }),
    // Tractors SIGNED OUT today — the yard's own record of leaving, which
    // exists for every unit whether or not it carries a tracker. Same shape as
    // the truck query below; the two differ only by vehicle type, and neither
    // can see paperwork whose plate never resolved (reported separately).
    prisma.dispatch.findMany({
      where: {
        organisationId: orgId,
        dispatchedAt:   { gte: dayStart },
        vehicle:        { vehicleType: 'TRACTOR' },
        ...vehicleWhere,
      },
      select:  { id: true, plate: true, driverName: true, destination: true, dispatchedAt: true },
      orderBy: { dispatchedAt: 'asc' },
    }),
    prisma.dispatch.findMany({
      where: {
        organisationId: orgId,
        dispatchedAt:   { gte: dayStart },
        vehicle:        { vehicleType: 'TRUCK' },
        ...vehicleWhere,
      },
      select:  { plate: true, driverName: true, destination: true, dispatchedAt: true },
      orderBy: { dispatchedAt: 'desc' },
    }),
    // Paperwork whose plate never resolved to our registry has NO vehicle row
    // and therefore no type — it cannot be counted as a truck or excluded as
    // one. Reported separately so the truck figure is not quietly short.
    // Under a vehicle filter this is 0, not the fleet-wide figure: paperwork
    // whose plate never resolved has no vehicle row and therefore no category,
    // so it can neither be counted into the chosen one nor left standing as a
    // fleet-wide caveat beside figures that are no longer fleet-wide.
    vehicleIds != null ? Promise.resolve(0) : prisma.dispatch.count({
      where: { organisationId: orgId, dispatchedAt: { gte: dayStart }, vehicleId: null },
    }),
  ])

  // Local hour in the fleet's timezone. EAT is a fixed +3 with no DST, so the
  // shift-and-read is exact — no Intl round trip needed per row.
  const localHour = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).getUTCHours()
  const before = (h: number) => tractorDispatches.filter(d => localHour(d.dispatchedAt) < h).length

  // WHO went out early — plate and crew, not just a count.
  const earlyRows = tractorDispatches.filter(d => localHour(d.dispatchedAt) < 6)

  // The measured barrier crossing for those runs, where telemetry caught one.
  // Keyed `yd-<dispatchId>` by lib/yard-departure, so this is one indexed read
  // over the early rows rather than a scan of the day's feed.
  //
  // A departure the fixes could not TIME still produces a feed line (the
  // `bounded` branch there — the unit was never seen at the gate). Those rows
  // carry a timestamp that is not a crossing time, so they must not be quoted
  // as one; the run still counts, on its sign-out clock, like every other. The
  // wording is the only signal there is — no precision column exists yet.
  const gateNotes = earlyRows.length
    ? await prisma.notification.findMany({
        where:  { organisationId: orgId, feedId: { in: earlyRows.map(d => `yd-${d.id}`) } },
        select: { feedId: true, occurredAt: true, text: true },
      })
    : []
  const gateAtById = new Map(
    gateNotes
      .filter(n => !n.text.includes('departure time not observed'))
      .map(n => [n.feedId.slice(3), n.occurredAt]),
  )

  const earlyList = earlyRows
    .map(d => ({
      plate: d.plate,
      // Free text from the provider, verbatim — never a placeholder, which
      // would read as a real crew member.
      driver:      d.driverName,
      destination: d.destination,
      /** When the yard signed it out. This is the departure. */
      at:          d.dispatchedAt.toISOString(),
      /** When telemetry watched it clear the barrier, for the minority of
       *  units that carry a tracker and reported. Null is the normal case and
       *  means "not measured", never "did not leave". */
      gateAt:      gateAtById.get(d.id)?.toISOString() ?? null,
    }))
    .sort((a, b) => a.at.localeCompare(b.at))

  const filledMl = fillings.reduce((s, f) => s + f.filledMl, 0)

  return {
    asOf:      now.toISOString(),
    dayStart:  dayStart.toISOString(),
    /** The fleet-local calendar day these figures cover. */
    day:       fleetDayKey(now),

    fleet: {
      /** Registry-active units, and what they are. Not a connectivity figure. */
      active: fleet.reduce((s, r) => s + r._count._all, 0),
      byType: Object.fromEntries(fleet.map(r => [r.vehicleType, r._count._all])),
    },

    /** Running total since local midnight. Litres measured; cost is priced by
     *  the caller at the server's rate, exactly as the month card is. */
    fuel: {
      filledMl,
      fillings: fillings.length,
    },

    /** Tractors signed out before each local hour today. Cumulative: before05
     *  includes everything before 04, so they must not be added up. */
    earlyDepartures: {
      tractorsOut:     tractorDispatches.length,
      before04:        before(4),
      before05:        before(5),
      before06:        before(6),
      /** How many of the pre-06:00 runs telemetry also watched clear the
       *  barrier — the measurement's own coverage, stated so nobody reads the
       *  count above as a GPS-confirmed figure. */
      gateConfirmed:   earlyList.filter(r => r.gateAt != null).length,
      /** The pre-06:00 sign-outs themselves — plate, crew, where, when. */
      list:            earlyList,
    },

    dispatches: {
      trucks: truckDispatches.length,
      truckList: truckDispatches.map(d => ({
        plate:       d.plate,
        driver:      d.driverName,
        destination: d.destination,
        at:          d.dispatchedAt.toISOString(),
      })),
      /** Raised today against a plate that is not in our registry. */
      plateUnresolved: unresolvedDispatches,
    },
  }
}
