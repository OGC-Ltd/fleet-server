/**
 * When machines START, and how long they RUN — by machine category.
 *
 * Both questions are asked of plant and trucks, and neither is answerable from
 * the paperwork the rest of operations-today is built on. `earlyDepartures`
 * there counts tractor SIGN-OUTS, which is right for a fleet where most units
 * carry no tracker: the yard's record exists for every vehicle. An excavator is
 * not signed out. It is switched on, in a pit, and works without going
 * anywhere — so the only witness is its own telemetry.
 *
 * ## What counts as a START, and why the obvious answers are wrong
 *
 * Measured against KASULU on 2026-08-20, in the order the obvious definitions
 * failed:
 *
 *   "first ping of the day with the engine on" — every unit reads as started
 *   before 04:00, because 33 of 136 are still working at midnight and their
 *   first frame of the new fleet day is simply the next one. A machine that
 *   never stopped did not start; it continued.
 *
 *   "first engine_on transition" — still every unit before 04:00, and this one
 *   is worse because it looks defensible. `ignition_known` is true on only
 *   70.2% of KASULU frames; on the rest `engine_on` is derived from speed, so
 *   it flickers false/true/false within seconds as a machine stops and starts.
 *   `MUFINDI: EX 10` flips four times in fifty seconds. Every stop-and-go
 *   registers as a fresh start.
 *
 * So a start is the first working ping that follows a SUSTAINED stand-down —
 * STANDDOWN_MINUTES with no work at all. That is robust to the flicker, and it
 * is honest about overnight running: a unit that never stood down has no start
 * today, and is reported as such rather than credited with a midnight one.
 *
 * Validated against a complete day (2026-08-19): 125 units started, peaking at
 * 06:00–08:00 with 21, 23 and 20 — the actual shift change — and 21 before
 * 04:00. It also discriminates, which the broken versions did not: 7 of 14 FT
 * started before 04:00 against 1 of 24 EX.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { createWarmCache } from '../../lib/warm-cache.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { machinePrefix } from '../fuel/fuel-theft-classifier.js'
// The SHARED distance measurement — see vehicle-brief on why not a second copy.
import { coveredSince } from '../dispatches/dispatch.repository.js'

/**
 * How long a unit must have been idle for its next movement to count as
 * starting work rather than resuming it.
 *
 * An hour. Long enough to clear the flicker described above and any ordinary
 * pause — refuelling, a queue at the weighbridge, a crew change — and short
 * enough that a machine standing overnight and starting at 04:00 is caught.
 */
export const STANDDOWN_MINUTES = 60

/** The working day these machines are expected to cover, per the operator. */
export const EXPECTED_HOURS_PER_DAY = 18

/** The buckets the chart draws. Cumulative: `before05` includes everything
 *  before 04:00, so they must never be added together. */
export const START_BUCKETS = [4, 5, 6] as const

export interface CategoryStarts {
  /** Plate prefix — EX, DZ, CTR, FT. The operator's own vocabulary. */
  category: string
  /** Units that genuinely started work in the window. */
  started:  number
  before04: number
  before05: number
  before06: number
}

/**
 * Units that started work before each hour, by category, for one fleet day.
 *
 * The whole window is read in one pass: the lag() needs the twelve hours before
 * the day to know whether the first working ping after midnight followed a
 * stand-down or a night shift.
 */
async function computeEarlyStarts(
  orgId: string, day: Date = fleetDayStart(),
): Promise<{ day: string; categories: CategoryStarts[]; totalStarted: number }> {
  const dayEnd = new Date(day.getTime() + 24 * 3_600_000)

  const rows = await prisma.$queryRaw<Array<{ plate: string; started: Date }>>`
    WITH working AS (
      SELECT t.vehicle_id,
             v.registration_plate AS plate,
             t.captured_at,
             lag(t.captured_at) OVER (
               PARTITION BY t.vehicle_id ORDER BY t.captured_at) AS prev_work
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId}
         AND v.is_active
         -- Reaches BEFORE the day so the first frame after midnight can be
         -- told from a night shift that never stopped.
         AND t.captured_at >= ${day}::timestamp - interval '12 hours'
         AND t.captured_at <  ${dayEnd}
         AND (t.engine_on = true OR coalesce(t.speed_kmh, 0) > 0)
    )
    SELECT plate, min(captured_at) AS started
      FROM working
     WHERE captured_at >= ${day}
       AND captured_at <  ${dayEnd}
       AND (prev_work IS NULL
            OR captured_at - prev_work >= ${`${STANDDOWN_MINUTES} minutes`}::interval)
     GROUP BY 1`

  // The hour in the FLEET's own timezone. A start at 03:30 EAT is 00:30 UTC,
  // and bucketing on the UTC hour would file it under midnight.
  const hourFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', hour: '2-digit', hour12: false,
  })
  const hourOf = (d: Date): number => Number(hourFmt.format(d))

  const byCat = new Map<string, CategoryStarts>()
  for (const r of rows) {
    // Unprefixed plates are road vehicles on ordinary registrations; they are
    // grouped rather than dropped, because a chart that silently omits rows is
    // worse than one with an honest "other".
    const category = machinePrefix(r.plate) ?? 'OTHER'
    if (!byCat.has(category)) {
      byCat.set(category, { category, started: 0, before04: 0, before05: 0, before06: 0 })
    }
    const c = byCat.get(category)!
    const h = hourOf(r.started)
    c.started++
    if (h < 4) c.before04++
    if (h < 5) c.before05++
    if (h < 6) c.before06++
  }

  return {
  // The fleet day's own DATE, not the instant it began.
  //
  // A fleet day starts at 21:00 UTC the previous evening, so returning that
  // instant labelled the day one earlier than the day it describes, and every
  // reader had to know the convention to undo it. Neither did. The dash's
  // fmtDay appends "T00:00:00Z" to whatever it is given, so a full ISO string
  // became "...ZT00:00:00Z" and rendered "Invalid Date"; FleetStateSection
  // formatted the instant in the VIEWER's timezone, so a reader in Nairobi and
  // a reader in London saw different dates for the same figures.
  //
  // A bare YYYY-MM-DD has no timezone to get wrong, and it matches what every
  // other endpoint already returns — fuel trends, vehicle daily stats and the
  // telemetry repository all send fleetDayKey sliced to ten characters.
    day: fleetDayKey(new Date(day.getTime() + 1)).toISOString().slice(0, 10),
    // Busiest first: a category with two units should not head a chart.
    categories: [...byCat.values()].sort((a, b) => b.started - a.started),
    totalStarted: rows.length,
  }
}

export type OperatingRange = 'day' | 'week' | 'month'

const RANGE_DAYS: Record<OperatingRange, number> = { day: 1, week: 7, month: 30 }

export interface CategoryHours {
  category: string
  /** Units with at least one day of engine data in the range. */
  units:      number
  /** Days of data behind the figures — units x days, not calendar days. */
  unitDays:   number
  /** Mean hours a unit of this category ran per day it was observed. */
  meanHours:  number
  /** Every hour it ran across the range. */
  totalHours: number
  /** meanHours against EXPECTED_HOURS_PER_DAY, as a percentage. */
  utilisation: number
}

/**
 * Hours actually run, by category, over a day, a week or a month.
 *
 * Read from `fuel_daily_trends.engine_seconds` — "seconds the engine ran that
 * day, integrated from every fix and capped at MAX_ENGINE_GAP_SECONDS per gap.
 * A measurement, not an estimate." It is already rolled up per vehicle per
 * fleet day, which is what makes a month affordable: the alternative is
 * thirteen million telemetry rows.
 *
 * NOT the engine-hours meter beside it. That column is the machine's own
 * cumulative counter and its own doc warns why a delta between two boundary
 * reads misattributes hours across days — the adapter carries the last known
 * value forward.
 *
 * `engine_hour_sessions` is not used either: it is the other provider's table
 * and holds zero rows for KASULU.
 */
async function computeOperatingHours(
  orgId: string, range: OperatingRange = 'day',
): Promise<{
  range: OperatingRange; days: number; expectedHoursPerDay: number
  categories: CategoryHours[]
}> {
  const days = RANGE_DAYS[range]
  const from = new Date(fleetDayStart().getTime() - (days - 1) * 24 * 3_600_000)

  const rows = await prisma.$queryRaw<Array<{
    plate: string; unit_days: bigint; total_seconds: bigint
  }>>`
    SELECT v.registration_plate AS plate,
           count(*)::bigint                            AS unit_days,
           coalesce(sum(t.engine_seconds), 0)::bigint  AS total_seconds
      FROM fuel_daily_trends t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND v.is_active
       AND t.day >= ${from}::date
       AND t.engine_seconds IS NOT NULL
     GROUP BY 1`

  const byCat = new Map<string, { units: number; unitDays: number; seconds: number }>()
  for (const r of rows) {
    const category = machinePrefix(r.plate) ?? 'OTHER'
    if (!byCat.has(category)) byCat.set(category, { units: 0, unitDays: 0, seconds: 0 })
    const c = byCat.get(category)!
    c.units++
    c.unitDays += Number(r.unit_days)
    c.seconds  += Number(r.total_seconds)
  }

  const categories = [...byCat.entries()].map(([category, c]) => {
    // Per OBSERVED day, not per calendar day. A unit with three days of data in
    // a week ran its hours over three days, and dividing by seven would report
    // a machine that worked hard as idle.
    const meanHours = c.unitDays > 0 ? c.seconds / 3600 / c.unitDays : 0
    return {
      category,
      units:       c.units,
      unitDays:    c.unitDays,
      meanHours:   Math.round(meanHours * 10) / 10,
      totalHours:  Math.round(c.seconds / 3600),
      utilisation: Math.round((meanHours / EXPECTED_HOURS_PER_DAY) * 100),
    }
  }).sort((a, b) => b.units - a.units)

  return { range, days, expectedHoursPerDay: EXPECTED_HOURS_PER_DAY, categories }
}


export interface FleetWeekSummary {
  days: number
  expectedHoursPerDay: number
  /**
   * Mean hours a unit ran per day it reported, over COMPLETE days only. Today
   * is excluded on purpose: a part-day counted whole makes the mean a clock
   * reading rather than a measure of the fleet.
   */
  avgHoursPerDay: number
  /** Every hour the fleet ran in the window, today included. */
  totalHours: number
  /** Hours run since midnight. */
  hoursToday: number
  /** Ground covered since midnight, kilometres. */
  distanceTodayKm: number
  unitsReporting: number
  /** Ground covered by the whole fleet, kilometres. */
  totalDistanceKm: number
  /** Estate blocks a machine worked in. */
  blocksWorked: number
  /** Their combined extent, hectares. NOT ground cleared — see below. */
  blocksExtentHa: number
  /** Smallest and largest block worked, hectares — the "range". */
  smallestBlockHa: number | null
  largestBlockHa: number | null
  /**
   * The same three figures per fleet day, oldest first, so the summary cards
   * can draw the sparkline the rest of the row draws. A stat tile without one
   * reads as a different component from the four beside it, which is how a
   * dashboard starts looking assembled rather than designed.
   */
  byDay: Array<{ day: string; hours: number; distanceKm: number; blocks: number }>
}

/**
 * The week, for the summary card.
 *
 * ## Why there is no "area cleared" here
 *
 * It was asked for and it cannot be measured. Converting ground covered into
 * ground cleared needs the width of the implement doing the clearing, and
 * nothing records it: `vehicles.model` is set on 0 of KASULU's 218 active
 * units, so there is no blade, bucket or swath width to multiply by. Any
 * hectare figure would be a constant somebody invented times a distance.
 *
 * The machines that clear do move — dozers cover 1.27 km per engine hour,
 * crawlers 3.49 — so the arithmetic is possible the moment those widths exist.
 * Excavators, at 0.55, mostly work in place, and no width would make their
 * distance mean area.
 *
 * What IS measured is which estate blocks were worked, from the zone crossings
 * the fleet already records, and those blocks have true PostGIS areas. So the
 * card reports blocks worked and their extent.
 *
 * ## Today is included, and has to be
 *
 * `fuel_daily_trends` records days that have ENDED, so a window read from it
 * alone stops at yesterday — the card would sit on last night's numbers all
 * day and read as broken to anyone watching the fleet work. Today's engine
 * seconds and distance are integrated live from the fixes, the same way the
 * rollup does it and capped at the same 900 s per gap, then added in. The card
 * moves during the day because the fleet does.
 *
 * `blocksExtentHa` is the size of the blocks ENTERED, not ground cleared, and
 * the two differ by orders of magnitude — FARM#211 alone is 16,301 ha and a
 * machine crossing a corner of it has not cleared 16,301 hectares. The field is
 * named `blocksExtent` rather than `area` so no caller can quietly render it as
 * one, and the range is carried beside it because "19 blocks between 2 and
 * 16,301 ha" is honest where a single total is not.
 */
async function computeFleetWeekSummary(
  orgId: string, days = 7,
): Promise<FleetWeekSummary> {
  /**
   * The window is `days` FLEET DAYS ending today: today plus the days - 1
   * complete days behind it.
   *
   * `fromDay`, not `from`. The rollup is keyed by a DATE column and `from` is an
   * instant — 21:00 UTC the evening the fleet day began — so comparing it with
   * `${from}::date` in a UTC session yields the PREVIOUS calendar date and drags
   * one extra day into the window. Measured 2026-08-21 with days=7, byDay came
   * back 08-14 to 08-20: seven complete days, plus today folded into the totals
   * below, which is eight days reported as seven.
   *
   * fleetDayKey is the only place this conversion may happen — the same fix
   * fleet-state and fuel-trend both took, for the same reason.
   */
  const from    = new Date(fleetDayStart().getTime() - (days - 1) * 24 * 3_600_000)
  const fromDay = fleetDayKey(from)

  const [work] = await prisma.$queryRaw<Array<{
    unit_days: bigint; units: bigint; seconds: bigint; metres: bigint
  }>>`
    SELECT count(*)::bigint                                AS unit_days,
           count(DISTINCT t.vehicle_id)::bigint            AS units,
           coalesce(sum(t.engine_seconds), 0)::bigint      AS seconds,
           coalesce(sum(t.distance_m), 0)::bigint          AS metres
      FROM fuel_daily_trends t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND v.is_active
       AND t.day >= ${fromDay}`

  // Blocks a machine worked in, from the zone crossings already recorded, with
  // each block's true area off its PostGIS geometry. The feed id encodes the
  // zone — see lib/zone-presence, which builds `zn-<vehicle>-<zone>-i|o-<ms>`.
  const blocks = await prisma.$queryRaw<Array<{ ha: number }>>`
    WITH entered AS (
      SELECT DISTINCT split_part(n.feed_id, '-', 3) AS zone_id
        FROM notifications n
       WHERE n.organisation_id = ${orgId}
         AND n.alert_type = 'ZONE_ENTRY'
         AND n.occurred_at >= ${from})
    SELECT round((ST_Area(g.geom::geography) / 10000)::numeric, 1)::float8 AS ha
      FROM entered e
      JOIN geofences g ON g.id = e.zone_id
     WHERE g.geom IS NOT NULL
     ORDER BY ha`

  // Per day, for the sparklines. Same source and same window as the totals
  // above, so a card's headline and its plot cannot disagree.
  const daily = await prisma.$queryRaw<Array<{
    day: Date; seconds: bigint; metres: bigint; unit_days: bigint
  }>>`
    SELECT t.day, coalesce(sum(t.engine_seconds), 0)::bigint AS seconds,
           coalesce(sum(t.distance_m), 0)::bigint            AS metres,
           count(*)::bigint                                  AS unit_days
      FROM fuel_daily_trends t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId} AND v.is_active AND t.day >= ${fromDay}
     GROUP BY 1 ORDER BY 1`

  const blocksPerDay = await prisma.$queryRaw<Array<{ day: Date; blocks: bigint }>>`
    SELECT date_trunc('day', n.occurred_at)::date AS day,
           count(DISTINCT split_part(n.feed_id, '-', 3))::bigint AS blocks
      FROM notifications n
     WHERE n.organisation_id = ${orgId}
       AND n.alert_type = 'ZONE_ENTRY'
       AND n.occurred_at >= ${from}
     GROUP BY 1 ORDER BY 1`
  const blocksByDay = new Map(blocksPerDay.map(b => [b.day.toISOString().slice(0, 10), Number(b.blocks)]))

  // Today, live. The rollup stops at yesterday — see the header.
  const today = fleetDayStart()
  const [live] = await prisma.$queryRaw<Array<{ seconds: number; units: bigint }>>`
    WITH gaps AS (
      SELECT t.vehicle_id, t.engine_on,
             EXTRACT(EPOCH FROM (t.captured_at - lag(t.captured_at) OVER (
               PARTITION BY t.vehicle_id ORDER BY t.captured_at))) AS gap
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND t.captured_at >= ${today})
    SELECT coalesce(sum(least(gap, 900)) FILTER (WHERE engine_on AND gap > 0), 0)::float8 AS seconds,
           count(DISTINCT vehicle_id)::bigint AS units
      FROM gaps`
  const liveSeconds  = Number(live?.seconds ?? 0)
  const liveUnits    = Number(live?.units ?? 0)

  const liveDistance = await coveredSince(
    (await prisma.vehicle.findMany({
      where: { organisationId: orgId, isActive: true }, select: { id: true },
    })).map(v => ({ vehicleId: v.id, since: today })),
  )
  const liveMetres = [...liveDistance.values()].reduce((a, r) => a + r.coveredM, 0)

  // Complete days only, for the mean — see the header.
  const unitDays = Number(work?.unit_days ?? 0)
  const seconds  = Number(work?.seconds ?? 0)
  const areas    = blocks.map(b => b.ha)

  return {
    days,
    expectedHoursPerDay: EXPECTED_HOURS_PER_DAY,
    // Per OBSERVED unit-day, for the reason operatingHoursByCategory gives:
    // dividing by calendar days reports a hard-working fleet as idle.
    avgHoursPerDay:  unitDays > 0 ? Math.round((seconds / 3600 / unitDays) * 10) / 10 : 0,
    // Cumulative, so today belongs in it.
    totalHours:      Math.round((seconds + liveSeconds) / 3600),
    /** Hours run since midnight, so the caller can say the card is live. */
    hoursToday:      Math.round((liveSeconds / 3600) * 10) / 10,
    distanceTodayKm: Math.round(liveMetres / 1000),
    unitsReporting:  Number(work?.units ?? 0),
    totalDistanceKm: Math.round((Number(work?.metres ?? 0) + liveMetres) / 1000),
    blocksWorked:    areas.length,
    blocksExtentHa:  Math.round(areas.reduce((a, b) => a + b, 0)),
    smallestBlockHa: areas.length ? areas[0]! : null,
    largestBlockHa:  areas.length ? areas[areas.length - 1]! : null,
    byDay: daily.map((d) => {
      const key = d.day.toISOString().slice(0, 10)
      const dayUnitDays = Number(d.unit_days)
      return {
        day: key,
        // Per unit-day again, so the plot is the same measure as the headline
        // rather than a fleet total that swings with how many units reported.
        hours:      dayUnitDays > 0
          ? Math.round((Number(d.seconds) / 3600 / dayUnitDays) * 10) / 10 : 0,
        distanceKm: Math.round(Number(d.metres) / 1000),
        blocks:     blocksByDay.get(key) ?? 0,
      }
    }),
  }
}

/**
 * Warm caches for the three machine-operations endpoints.
 *
 * None of them had a cache of any kind, and the KASULU analytics page polls two
 * of them every sixty seconds. Measured against production 2026-08-20:
 * machine-starts 2.2–3.3 s and machine-summary 3.4–5.9 s, on EVERY request. So
 * each open tab was costing six to nine CPU-seconds a minute on an instance
 * whose sustained budget is a fraction of one vCPU, and two tabs open on the
 * page could saturate it between them.
 *
 * The historical half of these figures already comes from `fuel_daily_trends`,
 * so there is no rollup left to do here — the cost is the live day plus the
 * fact that every poll paid for it again. Caching is the whole fix: one build
 * per org per minute regardless of how many people are looking.
 *
 * The default 60 s refresh matches the page's own poll interval, so the data a
 * viewer sees is no more stale than it was before — it simply is not recomputed
 * per viewer.
 */
const startsCache = createWarmCache<Awaited<ReturnType<typeof computeEarlyStarts>>>({
  name: 'machine-starts',
  warmKeysFor: (orgId) => [orgId],
  compute: (orgId) => computeEarlyStarts(orgId),
})

const hoursCache = createWarmCache<Awaited<ReturnType<typeof computeOperatingHours>>>({
  name: 'machine-hours',
  // Only the range the page opens on is warmed; the other two enter the cache
  // on first use rather than having the warmer keep three ranges hot per org.
  warmKeysFor: (orgId) => [`${orgId}|week`],
  compute: (key) => {
    const sep = key.lastIndexOf('|')
    return computeOperatingHours(key.slice(0, sep), key.slice(sep + 1) as OperatingRange)
  },
})

const summaryCache = createWarmCache<Awaited<ReturnType<typeof computeFleetWeekSummary>>>({
  name: 'machine-summary',
  warmKeysFor: (orgId) => [`${orgId}|7`],
  compute: (key) => {
    const sep = key.lastIndexOf('|')
    return computeFleetWeekSummary(key.slice(0, sep), Number(key.slice(sep + 1)))
  },
})

export async function earlyStartsByCategory(orgId: string) {
  return startsCache.get(orgId)
}

export async function operatingHoursByCategory(orgId: string, range: OperatingRange = 'week') {
  return hoursCache.get(`${orgId}|${range}`)
}

export async function fleetWeekSummary(orgId: string, days = 7) {
  return summaryCache.get(`${orgId}|${days}`)
}
