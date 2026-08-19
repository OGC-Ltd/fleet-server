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
import { fleetDayStart } from '../../lib/provider-time.js'
import { machinePrefix } from '../fuel/fuel-theft-classifier.js'

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
export async function earlyStartsByCategory(
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
    day: day.toISOString(),
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
export async function operatingHoursByCategory(
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
