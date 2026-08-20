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
 *   IDLING    engine on, stationary
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
// The SHARED distance measurement, not a fourth copy of it. vehicle-brief's own
// comment explains why: a hand-copied twin bound its window differently and the
// two figures diverged by the session offset.
import { coveredSince } from '../dispatches/dispatch.repository.js'
import { machinePrefix } from '../fuel/fuel-theft-classifier.js'

/** How recently a unit must have reported to count as online. Two hours: the
 *  poll is quarter-hourly, so anything quieter than this has stopped, not
 *  skipped a beat. */
export const ONLINE_WINDOW_MINUTES = 120

/** Speed at or below which a running engine counts as idling rather than
 *  working. Two km/h — walking pace — because GPS jitter on a stationary
 *  machine reads a km/h or so and a machine creeping at 1 km/h is not
 *  travelling. */
export const IDLE_SPEED_KMH = 2

/** Longest gap between fixes that still counts as continuous running. Matches
 *  the rollup's own cap, so today's figure and the week's are the same measure
 *  rather than two that happen to share a unit. */
export const MAX_GAP_SECONDS = 900

export type UnitState = 'WORKING' | 'IDLING' | 'PARKED' | 'OFFLINE'

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
}

export interface FleetState {
  counts: Record<UnitState, number>
  /** State by machine category, for the donut's breakdown. */
  byCategory: Array<{ category: string; working: number; idling: number; parked: number; offline: number }>
  units: FleetStateRow[]
}

/**
 * Engine-on fixes and stationary engine-on fixes, per vehicle, for one window.
 *
 * Exported because the daily rollup and the live read of today must count the
 * same thing. If IDLE_SPEED_KMH ever moves, both sides move with it — and the
 * stored history does not, which is why `backfillTrendFixes` exists to restate
 * it rather than leaving old rows counted under an old threshold.
 */
export async function fixCountsForWindow(
  from: Date, to: Date, orgId?: string,
): Promise<Array<{ vehicleId: string; engineFixes: number; idleFixes: number }>> {
  const scope = orgId
    ? Prisma.sql`JOIN vehicles v ON v.id = t.vehicle_id
                  AND v.is_active AND v.organisation_id = ${orgId}`
    : Prisma.empty

  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; engine_fixes: bigint; idle_fixes: bigint
  }>>`
    SELECT t.vehicle_id,
           count(*)::bigint AS engine_fixes,
           count(*) FILTER (WHERE coalesce(t.speed_kmh, 0) <= ${IDLE_SPEED_KMH})::bigint AS idle_fixes
      FROM vehicle_telemetries t
      ${scope}
     WHERE t.captured_at >= ${from}
       AND t.captured_at <  ${to}
       AND t.engine_on = true
     GROUP BY 1`

  return rows.map(r => ({
    vehicleId:   r.vehicle_id,
    engineFixes: Number(r.engine_fixes),
    idleFixes:   Number(r.idle_fixes),
  }))
}

export async function fleetState(orgId: string): Promise<FleetState> {
  const now      = new Date()
  const today    = fleetDayStart()
  const onlineAt = new Date(now.getTime() - ONLINE_WINDOW_MINUTES * 60_000)
  const weekFrom  = new Date(today.getTime() -  6 * 24 * 3_600_000)
  const monthFrom = new Date(today.getTime() - 29 * 24 * 3_600_000)

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
  }>>`
    SELECT t.vehicle_id,
           coalesce(sum(t.engine_seconds) FILTER (WHERE t.day >= ${weekFrom}::date), 0)::bigint AS week_s,
           coalesce(sum(t.distance_m)     FILTER (WHERE t.day >= ${weekFrom}::date), 0)::bigint AS week_m,
           count(*) FILTER (WHERE t.day >= ${weekFrom}::date)::bigint AS week_days,
           coalesce(sum(t.engine_seconds), 0)::bigint AS month_s,
           coalesce(sum(t.distance_m), 0)::bigint     AS month_m,
           count(*)::bigint                           AS month_days
      FROM fuel_daily_trends t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId} AND v.is_active
       AND t.day >= ${monthFrom}::date
     GROUP BY 1`
  const rollupByVehicle = new Map(rollup.map(r => [r.vehicle_id, r]))

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
  // sum across days like everything else on fuel_daily_trends, so the week is
  // read from the rollup and only today is counted live.
  const [weekFixes, todayFixes] = await Promise.all([
    prisma.fuelDailyTrend.groupBy({
      by:    ['vehicleId'],
      where: {
        day:     { gte: fleetDayKey(weekFrom) },
        vehicle: { organisationId: orgId, isActive: true },
      },
      _sum: { engineFixes: true, idleFixes: true },
    }),
    fixCountsForWindow(today, new Date(today.getTime() + 86_400_000), orgId),
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

  const vehicles = await prisma.vehicle.findMany({
    where:  { organisationId: orgId, isActive: true },
    select: { id: true, registrationPlate: true },
  })

  // Today's ground covered, from the one shared implementation.
  const coveredToday = await coveredSince(
    vehicles.map(v => ({ vehicleId: v.id, since: today })),
  )

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

    const state: UnitState =
      l == null                                            ? 'OFFLINE'
      : !l.engine_on                                       ? 'PARKED'
      : (l.speed_kmh ?? 0) > IDLE_SPEED_KMH                ? 'WORKING'
      :                                                      'IDLING'

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
    }
  })

  const counts: Record<UnitState, number> = { WORKING: 0, IDLING: 0, PARKED: 0, OFFLINE: 0 }
  const cats = new Map<string, { category: string; working: number; idling: number; parked: number; offline: number }>()
  for (const u of units) {
    counts[u.state]++
    if (!cats.has(u.category)) {
      cats.set(u.category, { category: u.category, working: 0, idling: 0, parked: 0, offline: 0 })
    }
    const c = cats.get(u.category)!
    if (u.state === 'WORKING') c.working++
    else if (u.state === 'IDLING') c.idling++
    else if (u.state === 'PARKED') c.parked++
    else c.offline++
  }

  return {
    counts,
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
  warmKeysFor: (orgId) => [orgId],
  compute: (orgId) => fleetState(orgId),
})

export async function getFleetState(orgId: string): Promise<FleetState> {
  return stateCache.get(orgId)
}
