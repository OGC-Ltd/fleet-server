/**
 * What every unit is doing right now, and what it did today, this week and this
 * month.
 *
 * ## The four states, and why "online" is not one of them
 *
 * A donut of online-vs-offline says almost nothing on this fleet: measured on
 * KASULU 2026-08-20, 134 of 218 units were online and only 27 of those had an
 * engine running. The other 107 were parked and reporting, which is a different
 * thing from working and a different thing again from being dark.
 *
 *   WORKING   engine on, moving
 *   IDLING     engine on, not moving, on a unit whose work is travel
 *   STATIONARY engine on, not moving, on plant — which is what digging is
 *   PARKED    reporting, engine off
 *   OFFLINE   no ping inside ONLINE_WINDOW_MINUTES
 *
 * The stationary-running segment is the one worth drawing, and it is invisible
 * on an online/offline split. Read it with the caveat two sections down: for a
 * truck it is money burnt for nothing, for an excavator it is the job.
 *
 * ## Idle TIME is a ratio times a measurement, never a fix count
 *
 * The obvious way to total idle time is to count idling fixes and multiply by
 * the sampling interval. That is wrong here and produced 103 hours inside a
 * 24-hour day when first tried: the interval is not fixed — p50 28 s, p90 34 s,
 * p99 905 s — so any single figure is wrong for most units.
 *
 * So the fix counts supply only the RATIO of stationary running to running,
 * which is exact however irregular the sampling, and that ratio scales
 * `engine_seconds` from the daily rollup — itself "integrated from every fix
 * and capped per gap. A measurement, not an estimate."
 *
 * ## "Idling" is reported as STATIONARY RUNNING, and only counted where it means idle
 *
 * For a truck, engine-on-and-not-moving is idling: fuel burnt for nothing. For
 * an excavator it is the JOB — it sits in a pit and swings its arm, covering
 * 0.55 km per engine hour. The first version of this counted `MUFINDI - EX 22`
 * as 21.5 idle hours out of 22.5, which would have sent somebody to investigate
 * a machine that was digging all day.
 *
 * Speed cannot separate the two on plant, and nothing else in the telemetry
 * can either — the RPM sensors that would are configured on the units but their
 * values do not reach us. So the field is named `stationaryHours`, it is
 * reported for every unit because the measurement is real, and `idleHours` is
 * populated ONLY for categories whose work is travel. Naming it honestly is
 * the difference between a number an operator can act on and one that sends
 * fitters after working machines.
 *
 * ## Today comes from telemetry, not the rollup
 *
 * `fuel_daily_trends` records days that have ENDED — its newest row is always
 * yesterday. Reading "today" from it returned 23.7 hours four hours into the
 * fleet day. So today is integrated live from the fixes, the same way the
 * rollup does it, and only the week and month averages come from the rollup.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { createWarmCache } from '../../lib/warm-cache.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { measuredBurnRates } from '../fuel/fuel-burn-rate.service.js'
// The SHARED distance measurement, not a fourth copy of it. vehicle-brief's own
// comment explains why: a hand-copied twin bound its window differently and the
// two figures diverged by the session offset.
import { coveredSince } from '../dispatches/dispatch.repository.js'
import { machinePrefix } from '../fuel/fuel-theft-classifier.js'
import { getProbeReport } from '../fuel/probe-report.service.js'
import { vehicleFiguresForDay, IDLE_SPEED_KMH } from './vehicle-daily-stats.service.js'

/** How recently a unit must have reported to count as online. Two hours: the
 *  poll is quarter-hourly, so anything quieter than this has stopped, not
 *  skipped a beat. */
/**
 * How recently a tracker must have spoken to count as CONNECTED, hours.
 *
 * A day. Longer than the online window on purpose: the two answer different
 * questions. Reporting-now is "is this unit sending"; connected is "is the
 * device still on the network at all", which is what separates a lorry parked
 * in a shed overnight from one whose tracker has been dead for a month.
 */
export const CONNECTED_WINDOW_HOURS = 24

export const ONLINE_WINDOW_MINUTES = 120

/** Longest gap between fixes that still counts as continuous running. Matches
 *  the rollup's own cap, so today's figure and the week's are the same measure
 *  rather than two that happen to share a unit. */
export const MAX_GAP_SECONDS = 900

export type UnitState = 'WORKING' | 'IDLING' | 'STATIONARY' | 'PARKED' | 'OFFLINE'

/**
 * Categories whose work IS travel, so engine-on-and-stationary is genuinely
 * idle rather than the job.
 *
 * Excavators, dozers, crawlers, wheel loaders and graders are absent on
 * purpose: they work in place. Measured over a week, EX covers 0.55 km per
 * engine hour against LMV's 29 — the gap is the whole distinction.
 */
export const TRAVEL_CATEGORIES = new Set(['LMV', 'FT', 'FTT', 'MTR', 'BUS', 'TRK'])

export interface FleetStateRow {
  vehicleId: string
  plate:     string
  /** Plate prefix — EX, DZ, CTR. The operator's own machine vocabulary. */
  category:  string
  state:     UnitState
  lastSeenAt: Date | null
  /** Hours the engine ran today, and the mean per observed day over the week
   *  and the month. */
  hoursToday: number
  hoursWeekAvg: number
  hoursMonthAvg: number
  /**
   * Hours today the engine ran while the unit was stationary. Real for every
   * unit; it is only IDLE where travel is the work — see the header.
   */
  stationaryHoursToday: number
  /** The same, only where it means idle. Null for plant, whose work is
   *  stationary and which would otherwise read as 95% idle. */
  idleHoursToday: number | null
  idleHoursWeekAvg: number | null
  /** Ground covered today, and the mean per observed day. */
  distanceTodayKm: number
  distanceWeekAvgKm: number
  distanceMonthAvgKm: number
  /**
   * Ground WORKED, square kilometres, meaned per day the machine was measured.
   *
   * Excavators only — null on everything else, because nothing else has a
   * worked area. There is no "today" figure to go with these: the geometry
   * costs about fifteen seconds per machine and is drawn once a night, so the
   * current day has no row until it is over. Hours have a live today and area
   * does not, and pretending otherwise would put a figure in the column that
   * was really yesterday's.
   */
  areaWeekAvgKm2: number | null
  areaMonthAvgKm2: number | null

  /**
   * Fuel over the month, and the rates it supports.
   *
   * `fuelBurnL` is MODELLED — the vehicle's own derived rate times the seconds
   * its engine ran. `fuelDropL` is MEASURED — the tank's opening minus its
   * closing, summed. Both are carried because they answer different questions
   * and the gap between them is where a leak or a siphon shows up.
   */
  fuelBurnL: number | null
  fuelDropL: number | null
  /**
   * Litres per engine hour, MODELLED.
   *
   * Kept, but do not render it as a consumption figure. It is engine_burn_ml
   * over engine_seconds and engine_burn_ml is a rate times those same seconds,
   * so it returns the rate the model was given — and 689 of 815 vehicles
   * borrow that rate from their type median. Use `litresPerHourMeasured`.
   */
  litresPerHour: number | null
  /**
   * Litres per engine hour, MEASURED from the tank — see fuel-burn-rate.
   *
   * Null where the machine has no defensible measurement: no probe, a probe
   * reading outside its own tank, or too few clean days. Null is the honest
   * answer and must never be filled in with a type median.
   */
  litresPerHourMeasured: number | null
  /** The range of qualifying days behind that figure, and how many. */
  measuredLoLPerHour: number | null
  measuredHiLPerHour: number | null
  measuredDays: number | null
  /**
   * Litres per kilometre — TRAVEL CATEGORIES ONLY, null on plant.
   *
   * Position freezes at speed 0 on this telemetry, so a working excavator
   * reports about zero kilometres while burning eleven litres an hour. The
   * measured L/km for PLANT is 7.361, which is not a rate anybody can use — it
   * is the arithmetic saying the denominator is wrong. Same reason `idleHours`
   * is null on plant: a number that is meaningless for a category is worse than
   * an absent one, because it invites a comparison.
   */
  litresPerKm: number | null
  /** Litres per hectare worked — excavators only, where ground was measured. */
  litresPerHectare: number | null
  /** Hectares the bucket covered over the window. */
  hectares: number | null

  /**
   * What the unit's sensors are doing, from the probe report.
   *
   * `null` where the unit is not in the report at all. 'OK' means the fuel
   * probe is reporting and calibrated; the rest name the fault so a fitter
   * knows which trip to make — an uncalibrated sensor is a Wialon record
   * somebody has to correct, and sending someone to the machine wastes the
   * journey.
   */
  sensorHealth: 'OK' | 'DIED' | 'SILENT' | 'UNCALIBRATED' | 'NOT_FITTED' | 'TRACKER_SILENT' | 'UNKNOWN' | null
}

/**
 * How much of the fleet the system can actually see.
 *
 * A different question from what the units are DOING, and the one that matters
 * on a fleet whose vehicles mostly carry no tracker: measured on SUKARI, 284 of
 * 597 active vehicles have a device bound at all, so the working/idling/parked
 * split describes under half the yard and says nothing about the other half.
 *
 * The three counts are disjoint and sum to `total`, which is what lets them be
 * drawn as one ring. "Monitored" is the two tracked slices together; it is not
 * a slice of its own, because a category that contains another category cannot
 * be a wedge beside it.
 */
export interface FleetMonitoring {
  /** Every active vehicle on the org, tracked or not. */
  total: number
  /** Tracked and seen inside the online window — sending right now. */
  reportingNow: number
  /**
   * Tracked and seen at all in the last day: the device is alive on the
   * network even if it has gone quiet in the last couple of hours.
   *
   * Not derived from the payload's `networkType` or `signalStrengthPct`. Those
   * keys are present on every frame and null on every one of them — sampled
   * 4,000 frames from the last two hours, not a single value — so the provider
   * ships the fields without filling them. Recency of contact is the only
   * evidence of a live link this fleet actually produces.
   */
  connected: number
  /** Tracked, but nothing inside the window — provisioned and quiet. */
  trackedSilent: number
  /** No device bound at all. Not a fault; most of a haulage fleet. */
  untracked: number
}

export interface FleetState {
  counts: Record<UnitState, number>
  /** State by machine category, for the donut's breakdown. */
  byCategory: Array<{ category: string; working: number; idling: number; parked: number; offline: number }>
  units: FleetStateRow[]
  monitoring: FleetMonitoring
}

/**
 * One probe-report row reduced to the single thing a fleet table can show.
 *
 * Ordered by what an operator would act on first: a silent tracker is upstream
 * of every other reading, a dead probe is a workshop job, an uncalibrated
 * sensor is a data-entry job. NOT_FITTED is not a fault — nothing is broken
 * about a machine that never had the hardware.
 */
function healthOf(r: { trackerSilent: boolean; fuelProbe: { state: string }; fuelSensor: { uncalibrated: boolean; fitted: boolean } }):
  FleetStateRow['sensorHealth'] {
  if (r.trackerSilent) return 'TRACKER_SILENT'
  if (r.fuelProbe.state === 'DIED')    return 'DIED'
  if (r.fuelProbe.state === 'SILENT')  return 'SILENT'
  if (r.fuelSensor.uncalibrated)       return 'UNCALIBRATED'
  if (!r.fuelSensor.fitted)            return 'NOT_FITTED'
  if (r.fuelProbe.state === 'UNKNOWN') return 'UNKNOWN'
  return 'OK'
}

/**
 * @param window  the Analytics page's window, `{ days, to }`.
 *
 *   THE OUTER WINDOW IS THE CALLER'S. It was a fixed trailing 30 days, which
 *   made every figure built on it — `fuelBurnL`, the per-unit month averages,
 *   hectares, and the L/hr, L/km and L/ha rates derived from them — describe a
 *   month whatever range the operator had chosen above the table. Picking a
 *   fortnight and reading "Fuel L" gave the month's litres under the
 *   fortnight's heading.
 *
 *   The TODAY and WEEK tiers stay fixed on purpose. They answer "what is this
 *   machine doing now" and "how has its week gone", which are questions about
 *   the fleet rather than about the chosen period, and the columns say so.
 *
 *   Defaults reproduce the old behaviour exactly, so a caller that passes
 *   nothing still gets today, a trailing week and a trailing month.
 */
export async function fleetState(
  orgId: string, window: { days?: number; to?: Date } = {},
): Promise<FleetState> {
  const now      = new Date()
  const today    = fleetDayStart()
  const onlineAt = new Date(now.getTime() - ONLINE_WINDOW_MINUTES * 60_000)
  const weekFrom  = new Date(today.getTime() -  6 * 24 * 3_600_000)
  // The window's own span and anchor, defaulting to the trailing 30 days this
  // service used before it took one.
  const windowDays = Math.max(1, Math.trunc(window.days ?? 30))
  const windowEnd  = fleetDayStart(window.to ?? now)
  const monthFrom  = new Date(windowEnd.getTime() - (windowDays - 1) * 24 * 3_600_000)
  // The same two boundaries as fuel_daily_trends files its rows under.
  //
  // The rollup query below compared `${weekFrom}::date` against a DATE column.
  // `weekFrom` is 21:00 UTC six evenings ago — the fleet day's start — and
  // casting that in a UTC session yields the PREVIOUS calendar date, so the
  // window reached a day further back than the one it was named for: measured
  // 2026-08-20, '2026-08-13' where the fleet day is '2026-08-14'. The week
  // averaged eight days and called itself seven.
  //
  // It went unnoticed while every figure in the service shared the same wrong
  // boundary. Reading the idle ratio from the rollup surfaced it, because that
  // query used fleetDayKey and three KASULU units came back with a different
  // week average from the neighbouring numerator.
  //
  // fleetDayKey is the one place this conversion is allowed to happen — the
  // same fix fuel-trend.service took on 2026-08-14, for the same reason.
  const weekFromDay  = fleetDayKey(weekFrom)
  const monthFromDay = fleetDayKey(monthFrom)
  // The window's LAST day. Open-ended before, which is the same thing as
  // "ending today" only while the anchor IS today — on a past range it dragged
  // every day since into the totals.
  const monthToDay   = fleetDayKey(windowEnd)
  const todayKey     = fleetDayKey(today)
  /**
   * The rollup scans span BOTH tiers, and each tier is then picked out by its
   * own FILTER.
   *
   * The week is a trailing seven days from TODAY and the window is whatever was
   * chosen, so once the window can end in the past the two no longer nest.
   * Bounding the scan by the window alone — which is what simply adding an
   * upper bound would do — would have emptied the week columns for any past
   * range, since none of the last seven days would be in the scan at all.
   */
  const scanFromDay = new Date(Math.min(weekFromDay.getTime(), monthFromDay.getTime()))
  const scanToDay   = new Date(Math.max(todayKey.getTime(), monthToDay.getTime()))

  // ── the live state, from each unit's newest frame ────────────────────────
  const live = await prisma.$queryRaw<Array<{
    vehicle_id: string; last_at: Date; engine_on: boolean; speed_kmh: number | null
  }>>`
    SELECT DISTINCT ON (t.vehicle_id)
           t.vehicle_id, t.captured_at AS last_at, t.engine_on, t.speed_kmh
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId} AND v.is_active
       AND t.captured_at >= ${onlineAt}
     ORDER BY t.vehicle_id, t.captured_at DESC`
  const liveByVehicle = new Map(live.map(l => [l.vehicle_id, l]))

  // ── hours and distance, from the daily rollup ────────────────────────────
  const rollup = await prisma.$queryRaw<Array<{
    vehicle_id: string
    week_s: bigint; week_m: bigint; week_days: bigint
    month_s: bigint; month_m: bigint; month_days: bigint
    burn_ml: bigint; drop_ml: bigint
  }>>`
    SELECT t.vehicle_id,
           coalesce(sum(t.engine_seconds) FILTER (WHERE t.day >= ${weekFromDay} AND t.day <= ${todayKey}), 0)::bigint AS week_s,
           coalesce(sum(t.distance_m)     FILTER (WHERE t.day >= ${weekFromDay} AND t.day <= ${todayKey}), 0)::bigint AS week_m,
           count(*) FILTER (WHERE t.day >= ${weekFromDay} AND t.day <= ${todayKey})::bigint AS week_days,
           -- Still named month_* because that is what every reader of this
           -- row calls the outer tier; it is now THE SELECTED WINDOW.
           coalesce(sum(t.engine_seconds) FILTER (WHERE t.day >= ${monthFromDay} AND t.day <= ${monthToDay}), 0)::bigint AS month_s,
           coalesce(sum(t.distance_m)     FILTER (WHERE t.day >= ${monthFromDay} AND t.day <= ${monthToDay}), 0)::bigint AS month_m,
           count(*) FILTER (WHERE t.day >= ${monthFromDay} AND t.day <= ${monthToDay})::bigint AS month_days,
           -- Fuel over the same window. engine_burn_ml is MODELLED — a
           -- per-vehicle rate times the seconds the engine ran — and
           -- consumed_ml is MEASURED, the tank's own opening minus its
           -- closing. They answer different questions and both are carried,
           -- because the gap between them is the interesting part.
           coalesce(sum(t.engine_burn_ml) FILTER (WHERE t.day >= ${monthFromDay} AND t.day <= ${monthToDay}), 0)::bigint AS burn_ml,
           coalesce(sum(t.consumed_ml)    FILTER (WHERE t.day >= ${monthFromDay} AND t.day <= ${monthToDay}), 0)::bigint AS drop_ml
      FROM fuel_daily_trends t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId} AND v.is_active
       AND t.day >= ${scanFromDay} AND t.day <= ${scanToDay}
     GROUP BY 1`
  const rollupByVehicle = new Map(rollup.map(r => [r.vehicle_id, r]))

  // The measured burn rates, over the same month window. A second query rather
  // than a widening of the rollup above: it closes a fuel BALANCE across three
  // tables and reduces per vehicle to a median, which does not fold into a
  // per-vehicle sum. Measured at 58 ms against production, against a
  // fleet-state build that was already several seconds.
  // Deliberately NOT following the selected window. This is a per-vehicle
  // CALIBRATION — what this machine is measured to burn per engine hour — not a
  // total over a period, and it needs enough clean days behind it to mean
  // anything. Narrowing it to a one-day range would return null for most of the
  // fleet and a number built on a single day for the rest, which is worse than
  // an honestly wider basis.
  const measured = await measuredBurnRates(orgId, 30)

  // ── today's engine seconds, integrated from the fixes ────────────────────
  //
  // NOT from the rollup: that records days that have ENDED, so its newest row
  // is yesterday and reading "today" from it returned 23.7 hours four hours
  // into the fleet day. Integrated here the same way the rollup does it —
  // summing the gap between consecutive fixes while the engine is on, capped
  // per gap so a unit that went dark for six hours is not credited with them.
  const todayRun = await prisma.$queryRaw<Array<{ vehicle_id: string; seconds: number }>>`
    WITH gaps AS (
      SELECT t.vehicle_id,
             t.engine_on,
             EXTRACT(EPOCH FROM (t.captured_at - lag(t.captured_at) OVER (
               PARTITION BY t.vehicle_id ORDER BY t.captured_at))) AS gap
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND t.captured_at >= ${today})
    SELECT vehicle_id, sum(least(gap, ${MAX_GAP_SECONDS}))::float8 AS seconds
      FROM gaps
     WHERE engine_on = true AND gap IS NOT NULL AND gap > 0
     GROUP BY 1`
  const todayRunByVehicle = new Map(todayRun.map(t => [t.vehicle_id, t.seconds]))

  // ── the idling RATIO, today and over the week ────────────────────────────
  //
  // Counts, never durations: the sampling interval is irregular — p50 28 s, p99
  // 905 s — so a fix count times an assumed interval is wrong, and gave 103
  // idle hours inside a 24-hour day. The ratio is exact regardless of interval,
  // and the rollup's measured `engineSeconds` gives it a scale.
  //
  // The WEEK half used to scan a week of raw telemetry on every build: 4.95 s
  // and 2.1M buffers touched, the largest single cost in this service. Counts
  // sum across days, so the week is read from vehicle_daily_stats and only
  // today is counted live.
  //
  // vehicle_daily_stats, NOT fuel_daily_trends. The first attempt put these
  // counts on the fuel table and it covered 1,565 vehicle-days where telemetry
  // covered 2,002 — recordFuelTrends skips a unit with no fuel level that day,
  // so every unit with a dead probe drew its idle figure from whichever days
  // its probe happened to report. MUFINDI: MTR 11 had three days of six.
  const [weekFixes, todayFixes] = await Promise.all([
    prisma.vehicleDailyStat.groupBy({
      by:    ['vehicleId'],
      where: {
        day:     { gte: weekFromDay },
        vehicle: { organisationId: orgId, isActive: true },
      },
      _sum: { engineFixes: true, idleFixes: true },
    }),
    vehicleFiguresForDay(today, new Date(today.getTime() + 86_400_000), orgId),
  ])

  const weekByVehicle  = new Map(weekFixes.map(w => [w.vehicleId, w._sum]))
  const todayByVehicle = new Map(todayFixes.map(t => [t.vehicleId, t]))

  // Today counts toward the week too — the rollup stops at yesterday.
  const idleByVehicle = new Map<string, {
    today_run: number; today_idle: number; week_run: number; week_idle: number
  }>()
  for (const id of new Set([...weekByVehicle.keys(), ...todayByVehicle.keys()])) {
    const w = weekByVehicle.get(id)
    const t = todayByVehicle.get(id)
    idleByVehicle.set(id, {
      today_run:  t?.engineFixes ?? 0,
      today_idle: t?.idleFixes   ?? 0,
      week_run:  (w?.engineFixes ?? 0) + (t?.engineFixes ?? 0),
      week_idle: (w?.idleFixes   ?? 0) + (t?.idleFixes   ?? 0),
    })
  }

  // Worked ground per machine, meaned over the days it was measured.
  //
  // avg() already divides by the non-null rows, so this is the mean per day the
  // machine actually dug — not per calendar day. A machine that worked three
  // days out of seven reports what it does on a working day, which is the
  // figure an operator compares against another machine.
  const areaRows = await prisma.$queryRaw<Array<{
    vehicle_id: string; week_m2: number | null; month_m2: number | null; total_m2: number | null
  }>>`
    SELECT s.vehicle_id,
           avg(s.dig_area_m2) FILTER (WHERE s.day >= ${weekFromDay} AND s.day <= ${todayKey})::float8 AS week_m2,
           avg(s.dig_area_m2) FILTER (WHERE s.day >= ${monthFromDay} AND s.day <= ${monthToDay})::float8 AS month_m2,
           -- The total, for litres-per-hectare. A mean per day cannot be
           -- divided into a window of fuel, so this follows the window too.
           sum(s.dig_area_m2) FILTER (WHERE s.day >= ${monthFromDay} AND s.day <= ${monthToDay})::float8 AS total_m2
      FROM vehicle_daily_stats s
      JOIN vehicles v ON v.id = s.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND v.is_active
       AND s.dig_area_m2 IS NOT NULL
       AND s.day >= ${scanFromDay} AND s.day <= ${scanToDay}
     GROUP BY 1`
  const areaByVehicle = new Map(areaRows.map(a => [a.vehicle_id, a]))

  // Coverage, in one pass. `device_id LIKE 'wialon:%'` is the same test the
  // probe report uses for "has a tracker at all" — kept identical so the two
  // cards cannot disagree about how many units are monitored.
  const connectedAt = new Date(now.getTime() - CONNECTED_WINDOW_HOURS * 3_600_000)
  const [cover] = await prisma.$queryRaw<Array<{
    total: bigint; reporting: bigint; tracked: bigint; connected: bigint
  }>>`
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE v.device_id LIKE 'wialon:%')::bigint AS tracked,
           count(*) FILTER (WHERE v.device_id LIKE 'wialon:%' AND EXISTS (
             SELECT 1 FROM vehicle_telemetries t
              WHERE t.vehicle_id = v.id AND t.captured_at >= ${onlineAt}
           ))::bigint AS reporting,
           count(*) FILTER (WHERE v.device_id LIKE 'wialon:%' AND EXISTS (
             SELECT 1 FROM vehicle_telemetries t
              WHERE t.vehicle_id = v.id AND t.captured_at >= ${connectedAt}
           ))::bigint AS connected
      FROM vehicles v
     WHERE v.organisation_id = ${orgId} AND v.is_active`

  const monitoring: FleetMonitoring = {
    total:         Number(cover?.total ?? 0),
    reportingNow:  Number(cover?.reporting ?? 0),
    connected:     Number(cover?.connected ?? 0),
    trackedSilent: Number(cover?.tracked ?? 0) - Number(cover?.reporting ?? 0),
    untracked:     Number(cover?.total ?? 0) - Number(cover?.tracked ?? 0),
  }

  /**
   * Sensor health, from the probe report rather than re-derived here.
   *
   * That report already decides what a probe is doing and, crucially, tells a
   * dead probe apart from an uncalibrated one — a fitter's trip versus a Wialon
   * record somebody has to correct. Building a second opinion here would be a
   * second implementation of a verdict that can drift from the one the
   * maintenance page shows for the same unit.
   *
   * It is warm-cached on a ten-minute refresh, so this costs a memory read.
   */
  const probe = await getProbeReport(orgId).catch(() => [])
  const healthByVehicle = new Map(probe.map(r => [r.vehicleId, healthOf(r)]))

  const vehicles = await prisma.vehicle.findMany({
    where:  { organisationId: orgId, isActive: true },
    select: { id: true, registrationPlate: true },
  })

  // Today's ground covered, from the one shared implementation.
  const coveredToday = await coveredSince(
    vehicles.map(v => ({ vehicleId: v.id, since: today })),
  )

  /** Square metres to square kilometres, at the precision the card prints. */
  const km2 = (m2: number | null | undefined): number | null =>
    m2 == null ? null : Math.round((m2 / 1_000_000) * 10_000) / 10_000

  /**
   * The fuel block for one unit.
   *
   * Every rate is null rather than zero when its denominator is absent or
   * meaningless. A zero would invite the comparison the whole point is to
   * prevent — an excavator that "uses 0 L/km" reads as efficient when what it
   * really means is that it does not travel.
   */
  const fuelFor = (
    id: string,
    r: { burn_ml: bigint; drop_ml: bigint; month_s: bigint; month_m: bigint } | undefined,
    travels: boolean,
    totalM2: number | null,
  ) => {
    // The tank's own answer, where the tank has one. Absent for a machine
    // whose probe cannot be trusted — see fuel-burn-rate on DZ 16.
    const meas = measured.get(id)
    const burnL  = r ? Number(r.burn_ml) / 1000 : 0
    const dropL  = r ? Number(r.drop_ml) / 1000 : 0
    const hrs    = r ? Number(r.month_s) / 3600 : 0
    const km     = r ? Number(r.month_m) / 1000 : 0
    const ha     = totalM2 == null ? 0 : totalM2 / 10_000
    const round1 = (n: number) => Math.round(n * 10) / 10

    return {
      fuelBurnL: burnL > 0 ? Math.round(burnL) : null,
      // A negative drop is a day that carried a refuel, not fuel appearing.
      fuelDropL: dropL > 0 ? Math.round(dropL) : null,
      litresPerHour: burnL > 0 && hrs > 0 ? round1(burnL / hrs) : null,
      litresPerHourMeasured: meas?.lPerHour   ?? null,
      measuredLoLPerHour:    meas?.loLPerHour ?? null,
      measuredHiLPerHour:    meas?.hiLPerHour ?? null,
      measuredDays:          meas?.days       ?? null,
      // Travel categories only — see the field's own note.
      litresPerKm: travels && burnL > 0 && km > 0 ? round1(burnL / km) : null,
      litresPerHectare: burnL > 0 && ha > 0 ? Math.round(burnL / ha) : null,
      hectares: ha > 0 ? round1(ha) : null,
    }
  }

  const hours = (seconds: bigint | number | undefined): number =>
    Math.round((Number(seconds ?? 0) / 3600) * 10) / 10
  const perDay = (total: bigint | number | undefined, days: bigint | number | undefined): number => {
    const d = Number(days ?? 0)
    return d > 0 ? Math.round((Number(total ?? 0) / d) * 10) / 10 : 0
  }

  const units: FleetStateRow[] = vehicles.map((v) => {
    const l = liveByVehicle.get(v.id)
    const r = rollupByVehicle.get(v.id)
    const i = idleByVehicle.get(v.id)

    const category = machinePrefix(v.registrationPlate) ?? 'OTHER'
    const travels  = TRAVEL_CATEGORIES.has(category)

    /**
     * Engine on and not moving is IDLING on a lorry and STATIONARY on plant.
     *
     * The same reading, two different facts. A truck sitting with its engine
     * running is burning fuel for nothing, which is what "idling" means and
     * what somebody should be sent to stop. An excavator sitting with its
     * engine running is DIGGING — it works from a fixed position and covers
     * 0.55 km per engine hour against a road vehicle's 29.
     *
     * Calling both of them idle was reading a whole category as waste:
     * KASULU's excavators show 6 stationary hours in a working day and every
     * one of them was labelled Idling on the row while the Idle COLUMN beside
     * it correctly read a dash. The column was fixed and the state was not.
     *
     * STATIONARY is a state of its own rather than being folded into WORKING,
     * because the distinction is still worth seeing: a machine parked in a pit
     * with the engine on and a machine tramming between faces are both working
     * and an operator may want to tell them apart.
     */
    const state: UnitState =
      l == null                                            ? 'OFFLINE'
      : !l.engine_on                                       ? 'PARKED'
      : (l.speed_kmh ?? 0) > IDLE_SPEED_KMH                ? 'WORKING'
      : travels                                            ? 'IDLING'
      :                                                      'STATIONARY'

    const todayHours = hours(todayRunByVehicle.get(v.id))
    const weekSecs   = Number(r?.week_s ?? 0)
    const idleShareToday = (i?.today_run ?? 0) > 0 ? i!.today_idle / i!.today_run : 0
    const idleShareWeek  = (i?.week_run  ?? 0) > 0 ? i!.week_idle  / i!.week_run  : 0

    return {
      vehicleId: v.id,
      plate:     v.registrationPlate,
      category,
      state,
      lastSeenAt: l?.last_at ?? null,
      hoursToday:     todayHours,
      hoursWeekAvg:   perDay(Number(r?.week_s ?? 0) / 3600, r?.week_days),
      hoursMonthAvg:  perDay(Number(r?.month_s ?? 0) / 3600, r?.month_days),
      stationaryHoursToday: Math.round(todayHours * idleShareToday * 10) / 10,
      idleHoursToday: travels ? Math.round(todayHours * idleShareToday * 10) / 10 : null,
      idleHoursWeekAvg: travels ? perDay((weekSecs / 3600) * idleShareWeek, r?.week_days) : null,
      distanceTodayKm:    Math.round((coveredToday.get(v.id)?.coveredM ?? 0) / 1000),
      distanceWeekAvgKm:  perDay(Number(r?.week_m ?? 0) / 1000, r?.week_days),
      distanceMonthAvgKm: perDay(Number(r?.month_m ?? 0) / 1000, r?.month_days),
      // Null, not zero, on a unit with no worked ground: zero would claim a
      // machine that dug nothing where the truth is that it does not dig.
      areaWeekAvgKm2:  km2(areaByVehicle.get(v.id)?.week_m2),
      areaMonthAvgKm2: km2(areaByVehicle.get(v.id)?.month_m2),
      ...fuelFor(v.id, r, travels, areaByVehicle.get(v.id)?.total_m2 ?? null),
      sensorHealth: healthByVehicle.get(v.id) ?? null,
    }
  })

  const counts: Record<UnitState, number> = {
    WORKING: 0, IDLING: 0, STATIONARY: 0, PARKED: 0, OFFLINE: 0,
  }
  const cats = new Map<string, { category: string; working: number; idling: number; parked: number; offline: number }>()
  for (const u of units) {
    counts[u.state]++
    if (!cats.has(u.category)) {
      cats.set(u.category, { category: u.category, working: 0, idling: 0, parked: 0, offline: 0 })
    }
    const c = cats.get(u.category)!
    if (u.state === 'WORKING') c.working++
    else if (u.state === 'IDLING' || u.state === 'STATIONARY') c.idling++
    else if (u.state === 'PARKED') c.parked++
    else c.offline++
  }

  return {
    counts,
    monitoring,
    // Most units first — a category of two should not head the breakdown.
    byCategory: [...cats.values()]
      .sort((a, b) => (b.working + b.idling + b.parked + b.offline) - (a.working + a.idling + a.parked + a.offline)),
    units: units.sort((a, b) => b.hoursToday - a.hoursToday),
  }
}

/**
 * Served from the warmer.
 *
 * Was a hand-rolled Map with a two-minute TTL, which expired hard: past two
 * minutes the next viewer blocked on the whole ~7 s build. Same shape of bug
 * the probe report had, and the reason it went unnoticed is the same — the page
 * is fast for whoever follows a recent visitor and slow for whoever opens it
 * first.
 *
 * On the shared cache it is primed at boot and refreshed in the background, so
 * nobody waits, and its build cost shows up in the `warm-cache slow build` log
 * alongside every other cache instead of being invisible.
 *
 * The default 60 s refresh is twice as fresh as the TTL it replaces, and costs
 * no more: the build ran every two minutes on demand before and runs every
 * minute on the sweep now, against a page that polls at sixty seconds anyway.
 */
const stateCache = createWarmCache<FleetState>({
  name: 'fleet-state',
  // Keys grow with the window the operator picks, so they are capped and age
  // out oldest-first, exactly as the other windowed analytics caches are.
  maxEntries: 200,
  // Only the plain trailing month is warmed. The page's own default window is
  // the current month TO DATE, which lengthens by a day every day and so would
  // never match a warmed key anyway; at roughly a second a build that is a
  // cost worth paying on first view rather than one to keep a sweep busy with.
  warmKeysFor: (orgId) => [`${orgId}|30|now`],
  compute: (key) => {
    const [orgId = '', days = '30', anchor = 'now'] = key.split('|')
    return fleetState(orgId, {
      days: Number(days),
      to: anchor === 'now' ? undefined : new Date(anchor),
    })
  },
})

/** @param window the Analytics page's `{ days, to }`; omitted is the trailing
 *  month this service answered with before it took one. */
export async function getFleetState(
  orgId: string, window: { days?: number; to?: Date } = {},
): Promise<FleetState> {
  const days = Math.max(1, Math.trunc(window.days ?? 30))
  return stateCache.get(`${orgId}|${days}|${window.to ? window.to.toISOString() : 'now'}`)
}
