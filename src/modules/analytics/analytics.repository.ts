import { prisma } from '../../lib/prisma.js'
import { getSimFleetVehicleIds } from '../../lib/sim-fleet.js'
import { env } from '../../config/env.js'
import { fleetDayStart } from '../../lib/provider-time.js'
// The SHARED distance measurement, for the day the rollup has not closed
// yet — machine-operations reaches for the same one, and a second copy is
// how two cards on one page start disagreeing about how far a fleet went.
import { coveredSince } from '../dispatches/dispatch.repository.js'
import type { AnalyticsRange, SpeedingQuery, DeliveriesQuery } from './analytics.schema.js'
import { calculateDriverRating } from './driver-rating.js'
import type { FuelEventVerdict } from '../../../generated/prisma/client.js'
import { NO_FUEL_LEFT, NO_FUEL_ARRIVED } from '../fuel/fuel-adjudication.js'
import { vehicleSql } from './vehicle-filter.js'
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
      cargoManifest: { select: { description: true, arrivalWeightKg: true, declaredWeightKg: true } },
    },
    orderBy: { beganAt: 'asc' },
  })

  /**
   * Distance comes from TELEMETRY, not from trips.
   *
   * It used to be `sum(trip.mileageKm)`, which defines the fleet's ground
   * covered in terms of a pipeline two of the four organisations do not have
   * yet: Menengai and West Kenya Sugar build no trips, so their Distance
   * covered read a flat zero — not "we did not measure it" but "you did not
   * move", which is a different and false claim.
   *
   * `fuel_daily_trends.distance_m` is integrated from the fixes themselves and
   * needs no trips at all. It is the same column machine-operations already
   * reports its distances from, so the Analytics headline and the Machine
   * Operations card can no longer disagree about how far a fleet went.
   *
   * This CHANGES the number on fleets that do have trips: integrated fix
   * distance and summed trip mileage are different measurements, and trip
   * mileage only ever counted ground covered inside a built trip. The new
   * figure is the larger and the more complete of the two.
   *
   * `to_char` rather than returning the date and formatting it here: `day` is
   * a bare DATE, and handing it back as a timestamp to be re-formatted through
   * a +03:00 formatter is how a day lands on its neighbour.
   */
  const fromDay = windowDays[0]!
  const lastDay = windowDays[windowDays.length - 1]!
  const distanceRows = await prisma.$queryRaw<Array<{ day: string; metres: bigint }>>`
    SELECT to_char(t.day, 'YYYY-MM-DD')           AS day,
           coalesce(sum(t.distance_m), 0)::bigint AS metres
      FROM fuel_daily_trends t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND v.is_active
       AND t.day >= ${fromDay}::date
       AND t.day <= ${lastDay}::date
       ${vehicleSql(vehicleIds)}
     GROUP BY 1`
  const kmByDay = new Map(distanceRows.map(r => [r.day, Number(r.metres) / 1000]))

  /**
   * TODAY IS A DAY.
   *
   * `fuel_daily_trends` records days that have ENDED — the rollup runs at
   * 21:20 — so on any window containing the current fleet day the query above
   * returns nothing for it. Measured on the box: a seven-day window came back
   * with six days for all four organisations, every one of them missing today.
   * Left alone, "Distance covered" would quietly stop at midnight and a fleet
   * that had been running since dawn would read as having gone nowhere.
   *
   * So today is integrated live from the fixes, through the same
   * `coveredSince` machine-operations uses — jitter floor and implausible-hop
   * rejection included, because a distance that counts GPS noise is not a
   * smaller lie than one that stops at midnight.
   */
  const todayKey = fleetDayKey(fleetDayStart())
  if (windowDays.includes(todayKey)) {
    const units = await prisma.vehicle.findMany({
      where: {
        organisationId: orgId, isActive: true,
        ...(vehicleIds == null ? {} : { id: { in: vehicleIds } }),
      },
      select: { id: true },
    })
    const since = fleetDayStart()
    const covered = await coveredSince(units.map(v => ({ vehicleId: v.id, since })))
    const liveKm = [...covered.values()].reduce((a, r) => a + r.coveredM, 0) / 1000
    // Set, not add: the rollup has no row for today, so there is nothing here
    // to double-count. If it ever gains one, the live figure is the fresher.
    kmByDay.set(todayKey, liveKm)
  }

  const telemetryKm = [...kmByDay.values()].reduce((a, b) => a + b, 0)
  /* Days the fleet actually covered ground, which is the honest denominator
     for a per-day mean. The trip-based `activeDays` below counts days that saw
     a TRIP, and on a fleet with no trip pipeline that is zero. */
  const movingDays = [...kmByDay.values()].filter(km => km > 0).length

  /**
   * Whether trips are PENDING rather than absent.
   *
   * An organisation whose trip pipeline has never produced a row is not an
   * organisation that made no deliveries — it is one nobody has built trips
   * for yet, and rendering that as a confident zero is the same error the
   * distance figure was making. One indexed lookup, and the screen says so.
   */
  const everBuiltTrips = await prisma.trip.findFirst({
    where:  { vehicle: { organisationId: orgId } },
    select: { id: true },
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
    const kg      = manifestKg(t.cargoManifest)
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
  /* The distance mean divides by days the fleet MOVED, not days it delivered:
     on a fleet with no trip pipeline the latter is zero. */
  const telemetryPerDayKm = telemetryKm / (movingDays || 1)

  return {
    totals: {
      trips:      trips.length,
      tonnes:     t1(totalKg),
      distanceKm: Math.round(telemetryKm),
      windowDays: q.days,
      activeDays,
      /** Null-shaped, not zero-shaped: see `everBuiltTrips`. */
      tripsPending: everBuiltTrips == null,
    },
    products: [...products].map(([product, v]) => ({ product, trips: v.trips, tonnes: t1(v.kg) }))
      .sort((a, b) => b.tonnes - a.tonnes),
    depots: [...depots].map(([depot, v]) => ({ depot, trips: v.trips, tonnes: t1(v.kg) }))
      .sort((a, b) => b.tonnes - a.tonnes),
    // One entry per window day, oldest→newest, zeroed where nothing ran — the
    // charts always plot exactly `windowDays` days.
    byDay: windowDays.map((day) => {
      const v = byDay.get(day)
      return {
        day, trips: v?.trips ?? 0, tonnes: t1(v?.kg ?? 0), timely: v?.timely ?? 0,
        // From the telemetry series, so the sparkline under the headline is
        // measuring the same thing the headline is.
        distanceKm: Math.round(kmByDay.get(day) ?? 0),
      }
    }),
    byWeekday: byWeekday.map((trips, weekday) => ({ weekday, trips })), // weekday 0=Sun
    deliveries: { total: trips.length, timely: trips.length - interrupted, interrupted },
    distance: {
      totalKm:    Math.round(telemetryKm),
      perDayKm:   Math.round(telemetryPerDayKm),
      perWeekKm:  Math.round(telemetryPerDayKm * 7),
      perMonthKm: Math.round(telemetryPerDayKm * 30),
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
/**
 * What a trip carried, in kilograms.
 *
 * MEASURED first, DECLARED second. `arrivalWeightKg` is a load-cell reading at
 * trip end and is the better number wherever it exists — but nothing on this
 * fleet produces one (wialon.adapter hardcodes `cargoWeightKg: null` on every
 * frame), so in practice every figure here is the declared weight the sales
 * office entered on the run.
 *
 * The two are kept in separate columns rather than merged on write precisely so
 * this precedence can exist: the day load cells appear, they take over and the
 * history stays honest about which trips were weighed and which were declared.
 *
 * Returns 0, not null, because every caller is summing — a trip with no manifest
 * contributed no tonnage, and that IS zero for a total.
 */
function manifestKg(m: { arrivalWeightKg?: number | null; declaredWeightKg?: number | null } | null | undefined): number {
  return m?.arrivalWeightKg ?? m?.declaredWeightKg ?? 0
}

/**
 * A drain the product may call possible theft: its cause was judged SIPHON —
 * engine provably off and the fall sustained, or one of the standing / after-
 * refuel rules (fuel-theft-classifier's mayUseTheftWording, the same test the
 * live alerts use). The Fuel Consumption chart shows these apart from the rest
 * of what drained (operator, 28 Sep: "one of these should read suspected theft
 * ... subtract and have it as independent"), so a litre is in one bar or the
 * other, never both.
 */
export const isSuspectedTheft = (cause: string | null | undefined): boolean => cause === 'SIPHON'

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
  const [fillings, thefts, turbulence] = await Promise.all([
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
    /**
     * Probe turbulence per fleet day — the MEAN of the per-vehicle figure, and
     * the count of vehicles it stands on.
     *
     * MEAN, never a sum: turbulence is a magnitude per tank (±L of slosh), so a
     * sum would grow with the size of the fleet and describe nothing. `abs()`
     * because the column is signed in storage — the same reading every other
     * consumer takes of it (fuel-burn-rate, fuel-rate-series).
     *
     * `stops_averaged > 0` drops rows whose window never filled; with the null
     * check it removes about 10% (≈285 of ≈310 rows a day are usable). The
     * vehicle count travels with the figure because the population is a
     * MINORITY of the fleet — the probed units only, 160 of 597 at Sukari
     * measured 2026-08-28 — and a mean over a quarter of the yard should not be
     * read as the yard.
     *
     * Raw SQL rather than Prisma groupBy because the mean wants `abs()` inside
     * the aggregate. `to_char` rather than returning the DATE, so the fleet-day
     * key is a string built in the database and no timezone can be applied to
     * it twice on the way out.
     */
    /**
     * `Promise.resolve(...)` around the call, not just `.catch` after it.
     *
     * A tagged-template method that is not a real promise — which is what the
     * deep test double returns for an unstubbed `$queryRaw` — makes `.catch`
     * throw synchronously, OUTSIDE the Promise.all, and the whole read 500s
     * before any of the three queries has run. Wrapping normalises undefined
     * and a rejection to the same empty result.
     */
    Promise.resolve(prisma.$queryRaw<Array<{ day: string; turb_ml: number; vehicles: bigint }>>`
      SELECT to_char(t.day, 'YYYY-MM-DD')        AS day,
             avg(abs(t.turbulence_ml))::float8   AS turb_ml,
             count(*)::bigint                    AS vehicles
        FROM fuel_daily_trends t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND t.day >= ${windowDays[0]}::date
         AND t.day <= ${windowDays[windowDays.length - 1]}::date
         AND t.turbulence_ml IS NOT NULL
         AND t.stops_averaged > 0
         ${vehicleSql(vehicleIds)}
       GROUP BY 1
    `)
      /**
       * NON-FATAL, and it was not.
       *
       * `Promise.all` rejects wholesale, so a failure in this one supplementary
       * aggregate took the entire fuel ledger down with it — the litres, the
       * cost, the per-vehicle table, all 500. That is the wrong trade for a
       * dashed comparison line: the chart is perfectly readable without it and
       * unreadable without the ledger.
       *
       * Reachable for real. This is the only raw SQL in the read, so it is the
       * only part that can fail on something the Prisma client would have
       * caught — a renamed column, a migration not yet applied on one
       * environment, a permission on `fuel_daily_trends` that the ORM tables do
       * not need.
       */
      .catch(() => [] as Array<{ day: string; turb_ml: number; vehicles: bigint }>),
  ])

  // `stolenMl`/`thefts` are EVERY drain, as they always were; the suspected
  // theft among them is carried beside them — see isSuspectedTheft.
  interface Bucket { filledMl: number; stolenMl: number; fillings: number; thefts: number; suspectedTheftMl: number; suspectedThefts: number }
  const empty = (): Bucket => ({ filledMl: 0, stolenMl: 0, fillings: 0, thefts: 0, suspectedTheftMl: 0, suspectedThefts: 0 })
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

  let totalFilledMl = 0, totalStolenMl = 0, totalSuspectedMl = 0, totalSuspected = 0
  for (const f of fillings) {
    const d = dayBucket(fleetDayKey(f.filledAt)); d.filledMl += f.filledMl; d.fillings += 1
    const v = vehicleBucket(f.vehicleId, f.vehicle); v.filledMl += f.filledMl; v.fillings += 1
    totalFilledMl += f.filledMl
  }
  for (const t of thefts) {
    const d = dayBucket(fleetDayKey(t.beganAt)); d.stolenMl += t.stolenMl; d.thefts += 1
    const v = vehicleBucket(t.vehicleId, t.vehicle); v.stolenMl += t.stolenMl; v.thefts += 1
    totalStolenMl += t.stolenMl
    if (isSuspectedTheft(t.drainCause)) {
      d.suspectedTheftMl += t.stolenMl; d.suspectedThefts += 1
      v.suspectedTheftMl += t.stolenMl; v.suspectedThefts += 1
      totalSuspectedMl += t.stolenMl; totalSuspected += 1
    }
  }

  // Days that saw ANY fuel movement — the zero-filled series below is
  // presentation, so a per-day average must not divide by quiet days.
  const activeDays = byDay.size

  // `vehicles` arrives as a bigint from count(*) and is narrowed here rather
  // than at the edge: it reaches JSON eventually, and JSON.stringify throws on
  // a bigint rather than coercing it.
  // The isArray guard is the second half of the non-fatal contract above: a
  // driver that resolves with something other than rows — as the test double
  // does for an unstubbed $queryRaw — must leave the line empty, not throw
  // where the catch cannot reach.
  const turbulenceByDay = new Map(
    (Array.isArray(turbulence) ? turbulence : [])
      .map(t => [t.day, { turbMl: t.turb_ml, vehicles: Number(t.vehicles) }]))

  return {
    totals: {
      filledMl:   totalFilledMl,
      stolenMl:   totalStolenMl,
      fillings:   fillings.length,
      thefts:     thefts.length,
      suspectedTheftMl: totalSuspectedMl,
      suspectedThefts:  totalSuspected,
      windowDays: q.days,
      activeDays,
    },
    // One entry per window day, oldest→newest, zeroed where no fuel moved.
    //
    // Turbulence is the exception and is NULL where absent, never 0. A day with
    // no reading is UNKNOWN, not calm, and this is the normal case rather than
    // an edge one: fuel_daily_trends is written once per day at ~21:20 UTC,
    // just after the fleet day closes, so the CURRENT day has no row at all and
    // the rightmost point of the series is always null. A zero here would draw
    // a daily "the probes went quiet" dip that never happened.
    byDay: windowDays.map((day) => {
      const v = byDay.get(day) ?? empty()
      const t = turbulenceByDay.get(day)
      return {
        day, filledMl: v.filledMl, stolenMl: v.stolenMl, fillings: v.fillings, thefts: v.thefts,
        suspectedTheftMl: v.suspectedTheftMl, suspectedThefts: v.suspectedThefts,
        turbulenceMl:       t ? Math.round(t.turbMl) : null,
        turbulenceVehicles: t ? t.vehicles : 0,
      }
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
      suspectedTheftMl:  v.suspectedTheftMl,
      suspectedThefts:   v.suspectedThefts,
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

// Overspeeding threshold (km/h).
//
// From configuration, not a literal, because this number now has two readers
// that must never disagree: the driver-conduct policy below, and the live feed
// (lib/derived-alerts). It was a literal here while the feed could not report
// speeding at all — so the platform suspended drivers against a limit it never
// told an operator about. One value, one place, both sides.
const OVERSPEED_LIMIT_KMH = env.OVERSPEED_LIMIT_KMH

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
  /**
   * The unit this driver is on: the registration on their most recent trip,
   * and where they have no trips, the unit they are posted to.
   *
   * LAST DRIVEN FIRST, deliberately. A posting is paperwork — it says where
   * somebody was put, and it is written by the dispatch webhook, so it is as
   * current as that integration happens to be; the trip is the truck they
   * actually got into. But a driver on the registry who has not driven inside
   * the history this query holds is not a driver on no vehicle, and a column
   * of em-dashes for the whole night shift is worse than the weaker fact. So
   * the posting fills the gap, and `vehicleFrom` says which of the two this
   * is rather than letting the page guess.
   */
  vehicle:           string | null
  /** 'trip' — the unit last driven. 'assignment' — an open posting, used only
   *  where there is no trip to read. null — neither exists. */
  vehicleFrom:       'trip' | 'assignment' | null
  /** The same unit's descriptive name and provider class (TRUCK, TRACTOR,
   *  PLANT, …) — what the Drivers page's type filter classifies on, exactly as
   *  the map's Fleets funnel does. null wherever `vehicle` is null. */
  vehicleName:       string | null
  vehicleType:       string | null
  rating:            number
  trips:             number
  tonnes:            number
  mileageKm:         number
  fuelTheftCases:    number
  /** Every overspeeding alert raised while they drove, not one per trip:
   *  each case lowers the rating (operator, 2026-10-28). */
  overspeedingCases: number
  /** Harsh acceleration and hard braking reports from the unit's tracker
   *  (Wialon Green Driving) while they drove. Each lowers the rating. */
  harshAccelerationCases: number
  harshBrakingCases:      number
}

/**
 * One fuel event pinned to a driver.
 *
 * `attributedBy` is on the record because the routes are not equally
 * certain: 'record' means the event itself named the driver, 'trip' the trip
 * running on that vehicle at that instant, 'posting' the driver posted to it
 * then, 'posted' the driver posted to it now, for an event from before anyone
 * was. Nothing currently writes the first, so every case today is inferred —
 * and a card that shows a suspension-relevant count should be able to say so.
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
  attributedBy: 'record' | 'trip' | 'posting' | 'posted'
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
  /**
   * What the people reviewing the alert decided, where anyone has: an
   * escalation as theft is a CONFIRMED theft, the strongest a case can be.
   * Null while nobody has decided. See FuelTheft.reviewStatus.
   */
  review: 'confirmed' | 'not_theft' | 'probe_fault' | 'open' | null
  reviewNote: string | null
}

/** One harsh acceleration or hard braking report on a driver's trip. */
export interface DriverHarsh {
  id:    string
  at:    string
  kind:  'acceleration' | 'braking'
  plate: string | null
  route: string | null
  attributedBy: 'trip' | 'posting' | 'posted'
}

export interface DriverOverspeed {
  id:    string
  at:    string
  plate: string | null
  route: string | null
  /** Fastest reading and the limit it broke, km/h. */
  peakKmh:  number
  limitKmh: number
  /** 'record': the incident named the driver (the unit's assigned driver when
   *  it was captured). 'trip': the trip running at the time. 'posting': the
   *  driver posted to the unit at the time. 'posted': captured before the unit
   *  had any driver posted, credited to the one posted to it now. */
  attributedBy: 'record' | 'trip' | 'posting' | 'posted'
  /** An administrator escalated it on the Alerts page. */
  escalated: boolean
}

export interface DriverDetail {
  driver: {
    id: string; fullName: string; status: string; rating: number
    licenceNumber: string | null; employeeId: string | null
  }
  totals: {
    trips: number; mileageKm: number; tonnes: number; hoursOnRoad: number
    fuelTheftCases: number; overspeedingCases: number; windowDays: number
    /** Fuel cases a reviewer escalated as theft — a subset of fuelTheftCases. */
    confirmedTheftCases: number
    harshAccelerationCases: number; harshBrakingCases: number
    /** Fuel events on the unit while they drove it, chargeable or not. */
    fuelEventsSeen: number
  }
  heaviestLoad: { tonnes: number; date: string; route: string } | null
  byDay: { day: string; tonnes: number; mileageKm: number }[]
  /** Every case behind the two counts above, newest first. */
  incidents: { thefts: DriverIncident[]; overspeeds: DriverOverspeed[]; harsh: DriverHarsh[] }
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
  const [trips, thefts, speeding, assignments, harsh, postings] = await Promise.all([
    prisma.trip.findMany({
      where:  { driverId: { in: driverIds }, vehicle: { organisationId: orgId } },
      select: {
        driverId: true, vehicleId: true, beganAt: true, endedAt: true,
        mileageKm: true, durationSeconds: true, finalLocation: true,
        // For the roster's vehicle column — the unit last driven. Name and type
        // ride along so the page can filter drivers by the class of machine.
        vehicle:       { select: { registrationPlate: true, name: true, vehicleType: true } },
        route:         { select: { name: true, originName: true, destinationName: true } },
        cargoManifest: { select: { arrivalWeightKg: true, declaredWeightKg: true } },
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
        reviewStatus: true, reviewNote: true,
        vehicle: { select: { registrationPlate: true } },
      },
      orderBy: { beganAt: 'desc' },
    }),
    // Overspeeding as the Alerts page shows it: speeding incidents, one per
    // episode over the limit, each carrying the driver posted to the unit
    // when it was captured. The card used to count the raw `overspeeding`
    // flags and credit a driver only through a trip covering the instant, so
    // a driver the Alerts page names on several cases read 0 here whenever
    // no trip of theirs was recorded (KCP 145, 2026-10-29). De-escalated
    // incidents -- not a real overspeed -- are left out.
    prisma.speedingIncident.findMany({
      where:  { organisationId: orgId, OR: [{ reviewStatus: null }, { reviewStatus: { not: 'DEESCALATED' } }] },
      select: {
        id: true, vehicleId: true, driverId: true, startedAt: true,
        peakKmh: true, limitKmh: true, reviewStatus: true,
        vehicle: { select: { registrationPlate: true } },
      },
      orderBy: { startedAt: 'desc' },
    }),
    // Open postings, for the drivers with no trip to read a unit off. The
    // schema indexes exactly this ("which vehicle is this driver assigned to?"
    // on userId + unassignedAt); the rows are written by the RaiFactorySuite
    // dispatch webhook and by POST /vehicles/:id/assignments.
    prisma.vehicleAssignment.findMany({
      where: {
        userId: { in: driverIds },
        unassignedAt: null,
        vehicle: { organisationId: orgId },
      },
      select: {
        userId: true, assignmentType: true, assignedAt: true,
        vehicle: { select: { registrationPlate: true, name: true, vehicleType: true } },
      },
      orderBy: { assignedAt: 'desc' },
    }),
    // Harsh acceleration and braking, as the harsh-driving worker records them
    // from the tracker's Green Driving reports. Attributed like overspeeding.
    prisma.providerAlert.findMany({
      where:  { organisationId: orgId, type: { in: ['HARSH_ACCELERATION', 'HARSH_BRAKING'] }, vehicleId: { not: null } },
      select: { id: true, vehicleId: true, type: true, createdAt: true, vehicle: { select: { registrationPlate: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    // Every posting of a roster driver, open or closed: who was on a unit at
    // an instant, for the overspeeding no trip covers.
    prisma.vehicleAssignment.findMany({
      where:  { userId: { in: driverIds }, vehicle: { organisationId: orgId } },
      select: { userId: true, vehicleId: true, assignedAt: true, unassignedAt: true },
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

  // Who was posted to a unit, from the roster drivers' postings: at an
  // instant, before it, and now. A unit with two drivers posted at once is
  // ambiguous and answers null.
  const postingsByVehicle = new Map<string, typeof postings>()
  for (const p of postings) {
    const arr = postingsByVehicle.get(p.vehicleId) ?? []
    arr.push(p); postingsByVehicle.set(p.vehicleId, arr)
  }
  const postedAt = (vehicleId: string, at: Date): string | null => {
    const on = [...new Set((postingsByVehicle.get(vehicleId) ?? [])
      .filter(p => p.assignedAt <= at && (p.unassignedAt == null || p.unassignedAt > at))
      .map(p => p.userId))]
    return on.length === 1 ? on[0] : null
  }
  const postedBefore = (vehicleId: string, at: Date): boolean =>
    (postingsByVehicle.get(vehicleId) ?? []).some(p => p.assignedAt <= at)
  const postedNow = (vehicleId: string): string | null => {
    const on = [...new Set((postingsByVehicle.get(vehicleId) ?? []).filter(p => p.unassignedAt == null).map(p => p.userId))]
    return on.length === 1 ? on[0] : null
  }

  /**
   * Fuel events, pinned to whoever had the unit at the time, first match wins:
   * an explicit `driverId` (nothing writes it yet), the driver of the trip
   * covering that instant, the roster driver posted to the unit then, and --
   * for an event from before the unit had any driver posted -- the one driver
   * posted to it now. The same routes overspeeding takes below.
   *
   * The postings are what put KCP 145P's four de-escalated siphons on its
   * driver's card (operator, 2026-10-29): the unit has no trips, so the trip
   * route alone left every Menengai fuel case unattributed.
   *
   * Only the first three may count against the driver. A case from before
   * anyone was posted is shown on the card of who holds the unit now, but
   * conductStatus SUSPENDS at two fuel-theft cases, and that driver was not
   * there.
   */
  const theftsByDriver = new Map<string, DriverIncident[]>()
  for (const th of thefts) {
    const hit = th.driverId ? null : (tripsByVehicle.get(th.vehicleId) ?? []).find(t =>
      t.driverId && th.beganAt >= t.beganAt && (t.endedAt == null || th.beganAt <= t.endedAt),
    )?.driverId ?? null
    const posting = th.driverId || hit ? null : postedAt(th.vehicleId, th.beganAt)
    const posted = th.driverId || hit || posting || postedBefore(th.vehicleId, th.beganAt)
      ? null : postedNow(th.vehicleId)
    const driverId = th.driverId ?? hit ?? posting ?? posted
    if (!driverId) continue
    const attributedBy = th.driverId ? 'record' : hit ? 'trip' : posting ? 'posting' : 'posted'

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
      attributedBy,
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
      //
      // A person's decision outranks the detector's (operator, 2026-10-29: the
      // driver card is for CONFIRMED thefts): an alert escalated as theft
      // counts whatever the classifier called it, and one a reviewer cleared
      // -- not a theft, or a faulty probe -- no longer counts even if it was
      // a siphon.
      countsAgainstDriver: attributedBy !== 'posted' && (th.reviewStatus === 'CONFIRMED_THEFT'
        || (th.drainCause === 'SIPHON' && th.reviewStatus !== 'NOT_THEFT' && th.reviewStatus !== 'PROBE_FAULT')),
      review: th.reviewStatus === 'CONFIRMED_THEFT' ? 'confirmed'
        : th.reviewStatus === 'NOT_THEFT' ? 'not_theft'
        : th.reviewStatus === 'PROBE_FAULT' ? 'probe_fault'
        : th.reviewStatus ? 'open' : null,
      reviewNote: th.reviewNote ?? null,
    })
    theftsByDriver.set(driverId, arr)
  }

  // Overspeeding per driver, first match wins:
  //   1. the driver the incident names, when they are on the roster (a
  //      dispatch posting can name a user who is not a driver);
  //   2. the driver of the trip running on that unit at that instant;
  //   3. the roster driver posted to the unit at that instant;
  //   4. an incident from before the unit had ANY driver posted -- Menengai's
  //      roster went in on 2026-10-21, months after its trackers began
  //      reporting -- goes to the one roster driver posted to the unit now.
  //      Two or more posted now is ambiguous and it stays unattributed.
  // Steps 3-4 are what put KCP 145P's cases on its driver's card (operator,
  // 2026-10-29: "he has overspeed cases but his card shows 0"). The card says
  // which route credited each case.
  //
  // Every incident lowers the rating (operator, 2026-10-28). The suspension
  // rate still counts TRIPS oversped, one however many incidents a trip
  // raised, so `cases / trips` keeps reading as a share of trips.
  const onRoster = new Set(driverIds)
  const overspeedTripsByDriver = new Map<string, Set<TripRow>>()
  const overspeedsByDriver = new Map<string, DriverOverspeed[]>()
  for (const a of speeding) {
    const named = a.driverId && onRoster.has(a.driverId) ? a.driverId : null
    const hit = (tripsByVehicle.get(a.vehicleId) ?? []).find(t =>
      (named ? t.driverId === named : !!t.driverId)
        && a.startedAt >= t.beganAt && (t.endedAt == null || a.startedAt <= t.endedAt),
    )
    const posting = named || hit?.driverId ? null : postedAt(a.vehicleId, a.startedAt)
    const posted = named || hit?.driverId || posting || postedBefore(a.vehicleId, a.startedAt)
      ? null : postedNow(a.vehicleId)
    const driverId = named ?? hit?.driverId ?? posting ?? posted
    if (!driverId) continue
    if (hit) {
      const set = overspeedTripsByDriver.get(driverId) ?? new Set<TripRow>()
      set.add(hit); overspeedTripsByDriver.set(driverId, set)
    }
    const arr = overspeedsByDriver.get(driverId) ?? []
    arr.push({
      id:        a.id,
      at:        a.startedAt.toISOString(),
      plate:     a.vehicle?.registrationPlate ?? null,
      route:     hit?.route?.name ?? null,
      peakKmh:   Math.round(a.peakKmh),
      limitKmh:  Math.round(a.limitKmh),
      attributedBy: named ? 'record' : hit?.driverId ? 'trip' : posting ? 'posting' : 'posted',
      escalated: a.reviewStatus === 'ESCALATED',
    })
    overspeedsByDriver.set(driverId, arr)
  }

  // Harsh driving per driver: every report counts, credited like overspeeding
  // (trip, then the posting at the time, then -- before the unit had any
  // driver posted -- the one posted now). Kept as instants so the detail can
  // window them. Trip-only crediting missed every unit with no trips recorded,
  // KCP 145P's harsh acceleration of 2026-10-28 among them.
  const harshByDriver = new Map<string, { accel: Date[]; brake: Date[] }>()
  const harshListByDriver = new Map<string, DriverHarsh[]>()
  for (const h of harsh) {
    if (!h.vehicleId) continue
    const hit = (tripsByVehicle.get(h.vehicleId) ?? []).find(t =>
      t.driverId && h.createdAt >= t.beganAt && (t.endedAt == null || h.createdAt <= t.endedAt),
    )
    const vId = h.vehicleId
    const driverId = hit?.driverId ?? postedAt(vId, h.createdAt)
      ?? (postedBefore(vId, h.createdAt) ? null : postedNow(vId))
    if (!driverId) continue
    const entry = harshByDriver.get(driverId) ?? { accel: [], brake: [] }
    ;(h.type === 'HARSH_ACCELERATION' ? entry.accel : entry.brake).push(h.createdAt)
    harshByDriver.set(driverId, entry)
    const list = harshListByDriver.get(driverId) ?? []
    list.push({
      id:    h.id,
      at:    h.createdAt.toISOString(),
      kind:  h.type === 'HARSH_ACCELERATION' ? 'acceleration' : 'braking',
      plate: h.vehicle?.registrationPlate ?? null,
      route: hit?.route?.name ?? null,
      attributedBy: hit?.driverId ? 'trip' : postedBefore(vId, h.createdAt) ? 'posting' : 'posted',
    })
    harshListByDriver.set(driverId, list)
  }

  /**
   * One plate per driver: PRIMARY before any other kind, and the newest
   * posting before an older one — a driver can hold two open rows (a primary
   * unit and a relief), and a column shows one thing.
   */
  type PostedUnit = { registrationPlate: string; name: string | null; vehicleType: string }
  const postedPlate = new Map<string, PostedUnit>()
  for (const a of [...assignments].sort((x, y) =>
    (x.assignmentType === y.assignmentType ? 0 : x.assignmentType === 'PRIMARY' ? -1 : 1)
    || (y.assignedAt.getTime() - x.assignedAt.getTime()))) {
    if (!postedPlate.has(a.userId)) postedPlate.set(a.userId, a.vehicle)
  }

  const roster: DriverRosterRow[] = []
  const details: Record<string, DriverDetail> = {}

  for (const d of drivers) {
    const dTrips = tripsByDriver.get(d.id) ?? []
    const dThefts = theftsByDriver.get(d.id) ?? []
    // Only the siphons count against them — see countsAgainstDriver.
    const chargeable = dThefts.filter(i => i.countsAgainstDriver).length
    // Trips oversped, for the suspension rate; every alert, for the rating.
    const lifetimeOverspeed = overspeedTripsByDriver.get(d.id)?.size ?? 0
    const lifetimeOverspeedAlerts = overspeedsByDriver.get(d.id)?.length ?? 0
    const dHarsh = harshByDriver.get(d.id) ?? { accel: [], brake: [] }
    let lifetimeKm = 0, lifetimeKg = 0
    for (const t of dTrips) {
      lifetimeKm += t.mileageKm ?? 0
      lifetimeKg += manifestKg(t.cargoManifest)
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
      overspeedingCases: lifetimeOverspeedAlerts,
      harshAccelerationCases: dHarsh.accel.length,
      harshBrakingCases: dHarsh.brake.length,
      daysSinceLastTrip,
    })
    const rating = ratingResult.rating

    // ── Roster row: lifetime aggregates ──
    // Employment status escalated by lifetime conduct (see conductStatus) —
    // the roster badge and the detail header both use this derived value.
    const status = conductStatus(d.status, dTrips.length, chargeable, lifetimeOverspeed)

    // `dTrips` is ordered by beganAt ascending, so the last entry is the most
    // recent trip and its vehicle is the unit this driver was last in. Where
    // there is no trip at all, the open posting stands in for it.
    const lastUnit = dTrips.length ? dTrips[dTrips.length - 1].vehicle ?? null : null
    const lastDriven = lastUnit?.registrationPlate ? lastUnit : null
    const posted = postedPlate.get(d.id) ?? null
    const unit = lastDriven ?? posted
    const vehicle = unit?.registrationPlate ?? null
    const vehicleFrom: DriverRosterRow['vehicleFrom'] =
      lastDriven ? 'trip' : posted ? 'assignment' : null

    roster.push({
      id:                d.id,
      fullName:          d.fullName,
      status,
      vehicle,
      vehicleFrom,
      vehicleName:       unit?.name ?? null,
      vehicleType:       unit?.vehicleType ?? null,
      rating,
      trips:             dTrips.length,
      tonnes:            toTonnes(lifetimeKg),
      mileageKm:         Math.round(lifetimeKm),
      fuelTheftCases:    dThefts.filter(i => i.countsAgainstDriver).length,
      overspeedingCases: lifetimeOverspeedAlerts,
      harshAccelerationCases: dHarsh.accel.length,
      harshBrakingCases:      dHarsh.brake.length,
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
      const kg = manifestKg(t.cargoManifest)
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

    // Windowed cases: every alert in the window, the same count the roster
    // and the rating use, so the headline matches the case list under it.
    // Up to NOW, not to the latest trip: an incident captured on their
    // posted unit after their last recorded trip is still theirs to answer.
    const inWindow = (at: Date) => at >= from
    const windowOverspeeds = (overspeedsByDriver.get(d.id) ?? []).filter(o => inWindow(new Date(o.at)))
    const overspeedingCases = windowOverspeeds.length

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
        confirmedTheftCases: windowThefts.filter(i => i.review === 'confirmed').length,
        overspeedingCases,
        harshAccelerationCases: dHarsh.accel.filter(inWindow).length,
        harshBrakingCases:      dHarsh.brake.filter(inWindow).length,
        windowDays:        days,
      },
      // The cases behind the two counts, newest first. Scoped to the same
      // window the counts use, so a card cannot list five events under a
      // headline of three.
      incidents: {
        thefts:     windowThefts,
        overspeeds: windowOverspeeds,
        harsh:      (harshListByDriver.get(d.id) ?? []).filter(h => inWindow(new Date(h.at))),
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
      cargoManifest: { select: { arrivalWeightKg: true, declaredWeightKg: true } },
    },
    orderBy: { beganAt: 'asc' },
  })

  let totalKm = 0, totalKg = 0, totalSeconds = 0
  const byDayMap = new Map<string, { tonnes: number; mileageKm: number }>()
  let heaviest: { kg: number; date: Date; route: string } | null = null

  for (const t of trips) {
    const kg = manifestKg(t.cargoManifest)
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
  let overspeedingCases = 0, harshAccelerationCases = 0, harshBrakingCases = 0
  if (vehicleIds.length > 0) {
    const [alerts, harsh] = await Promise.all([
      prisma.vehicleAlert.findMany({
        where:  { organisationId: orgId, vehicleId: { in: vehicleIds }, type: 'overspeeding', triggeredAt: { gte: from, lte: to } },
        select: { vehicleId: true, triggeredAt: true },
      }),
      prisma.providerAlert.findMany({
        where:  { organisationId: orgId, vehicleId: { in: vehicleIds }, type: { in: ['HARSH_ACCELERATION', 'HARSH_BRAKING'] }, createdAt: { gte: from, lte: to } },
        select: { vehicleId: true, type: true, createdAt: true },
      }),
    ])
    // Every alert during one of their trips — matches driversOverview.
    const onTrip = (vehicleId: string | null, at: Date) =>
      trips.some(t => t.vehicleId === vehicleId && at >= t.beganAt && at <= t.endedAt)
    overspeedingCases = alerts.filter(a => onTrip(a.vehicleId, a.triggeredAt)).length
    harshAccelerationCases = harsh.filter(h => h.type === 'HARSH_ACCELERATION' && onTrip(h.vehicleId, h.createdAt)).length
    harshBrakingCases = harsh.filter(h => h.type === 'HARSH_BRAKING' && onTrip(h.vehicleId, h.createdAt)).length
  }

  const finalDriverRating = driver
    ? calculateDriverRating({
        baseScore: driver.driverRatingScore ?? 5,
        trips: trips.length,
        mileageKm: trips.reduce((sum, t) => sum + (t.mileageKm ?? 0), 0),
        tonnes: toTonnes(trips.reduce((sum, t) => sum + manifestKg(t.cargoManifest), 0)),
        incentiveBonus: 0,
        fuelTheftCases,
        overspeedingCases,
        harshAccelerationCases,
        harshBrakingCases,
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
      harshAccelerationCases,
      harshBrakingCases,
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
    // Truck runs today. "Truck" is answered two ways on purpose.
    //
    // The registry type is the obvious test and it is the one that works for
    // SUKARI, whose 67 trucks are typed. It cannot work for MENENGAI or WEST
    // KENYA: those fleets arrive through sync:wialon, which sets no type at
    // all, so 241 of Menengai's 244 active units and 485 of West Kenya's 486
    // are UNSPECIFIED. A type-only filter therefore reports zero truck runs for
    // those orgs FOREVER, however many sugar hauls they run — which is exactly
    // what this card was doing for the Naitiri → Raiply traffic.
    //
    // A SALES run answers it from the other direction, and answers it better:
    // the lifecycle itself says what the run is. Finished sugar leaving a
    // factory for a customer is a haulage run by definition — the sales office
    // does not dispatch a tractor to Raiply — so the kind is evidence about the
    // journey where the registry has none about the vehicle.
    //
    // Fixing the registry types would be the deeper repair and is worth doing
    // separately; it needs the provider's own `type` field, which sync:wialon
    // does not read today. This is not a workaround for that so much as the
    // more direct question: the card counts haulage runs, and a sales run is
    // one whatever the vehicle row happens to say.
    prisma.dispatch.findMany({
      where: {
        organisationId: orgId,
        dispatchedAt:   { gte: dayStart },
        OR: [
          { vehicle: { vehicleType: 'TRUCK' } },
          { kind: 'SALES' },
        ],
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
