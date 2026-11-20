/**
 * Each probed machine's tank, day by day, for the Fuel page's Consumed column
 * (operator, 18 Nov 2026: Pump flags out, "fuel consumed" in, over each
 * machine's own plan period). The page works the balance for each row's
 * period:
 *
 *   consumed = level at the start of the period + fills − drains − level at its end
 *
 * from these rows: the start is the first day's opening level, the end the
 * last day's closing level (or the live probe reading when the period runs to
 * today, whose row is only written tonight by fuel-trend.service). A day with
 * no row yet, today, opens at the day before's closing level, so a period
 * that starts today still has a start.
 *
 * A balance over the whole period rather than a sum of daily burns, because
 * the daily burns are gappy (vehicle-fuel-days: about 4 days in 10 qualify);
 * the balance needs only its two ends and the events between them.
 *
 * Fills count unless the verdict says the level only wobbled or the probe
 * failed; drains count only where the verdict is that fuel left (DRAIN), so
 * fuel drained out of the tank is not reported as burnt.
 */
import { prisma } from '../../lib/prisma.js'
import { Prisma } from '../../../generated/prisma/client.js'

export interface TankDay {
  vehicleId: string
  /** The fleet day, YYYY-MM-DD (Nairobi). */
  day: string
  /** Level at the start of the day, litres; null when the probe gave none. */
  openingL: number | null
  /** Level at the end of the day, litres; null when the probe gave none. */
  closingL: number | null
  /** Litres the probe saw going in that day. */
  fillL: number
  /** Litres the probe saw leaving that day other than through the engine. */
  drainL: number
}

const NAIROBI_H = 3

/** Every probed unit's tank days in from..to (fleet days, inclusive), in the units `scope` allows. */
export async function tankDays(orgId: string, from: string, to: string, scope: ReadonlySet<string> | null = null): Promise<TankDay[]> {
  const fromAt = new Date(`${from}T00:00:00+0${NAIROBI_H}:00`)
  const toAt = new Date(Date.parse(`${to}T00:00:00+0${NAIROBI_H}:00`) + 86_400_000)
  const only = scope ? Prisma.sql`AND v.id = ANY(${[...scope]}::text[])` : Prisma.empty
  const rows = await prisma.$queryRaw<Array<{ vehicle_id: string, day: Date, opening_ml: number | null, closing_ml: number | null, fill_ml: number, drain_ml: number }>>`
    WITH t AS (
      SELECT t.vehicle_id, t.day, t.opening_ml, t.closing_ml
        FROM fuel_daily_trends t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND t.day >= ${from}::date AND t.day <= ${to}::date ${only}
    ),
    -- The day before's closing level, as the opening of a day with no trend
    -- row yet: today's is only written tonight (operator 2026-11-20, DG-08 on
    -- Today: "The fuel probe gave no tank level at the start" with the probe
    -- reading 59 of 135 L). Only the day before, never an older level.
    p AS (
      SELECT t.vehicle_id, t.day + 1 AS day, t.closing_ml
        FROM fuel_daily_trends t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND t.day >= ${from}::date - 1 AND t.day < ${to}::date
         AND t.closing_ml IS NOT NULL ${only}
    ),
    f AS (
      SELECT f.vehicle_id, (f.filled_at + interval '3 hours')::date AS day,
             sum(coalesce(f.observed_rise_ml, f.filled_ml))::float8 AS ml
        FROM fuel_fillings f
        JOIN vehicles v ON v.id = f.vehicle_id
       WHERE v.organisation_id = ${orgId} AND f.filled_at >= ${fromAt} AND f.filled_at < ${toAt}
         AND f.verdict NOT IN ('REDISTRIBUTION', 'SENSOR_FAULT') ${only}
       GROUP BY 1, 2
    ),
    d AS (
      SELECT th.vehicle_id, (th.detected_at + interval '3 hours')::date AS day,
             sum(greatest(0, th.initial_fuel_level_ml - th.final_fuel_level_ml))::float8 AS ml
        FROM fuel_thefts th
        JOIN vehicles v ON v.id = th.vehicle_id
       WHERE v.organisation_id = ${orgId} AND th.detected_at >= ${fromAt} AND th.detected_at < ${toAt}
         AND th.verdict = 'DRAIN' ${only}
       GROUP BY 1, 2
    ),
    keys AS (
      SELECT vehicle_id, day FROM t UNION SELECT vehicle_id, day FROM p
      UNION SELECT vehicle_id, day FROM f UNION SELECT vehicle_id, day FROM d
    )
    SELECT k.vehicle_id, k.day, coalesce(t.opening_ml, p.closing_ml) AS opening_ml, t.closing_ml,
           coalesce(f.ml, 0) AS fill_ml, coalesce(d.ml, 0) AS drain_ml
      FROM keys k
      LEFT JOIN t ON t.vehicle_id = k.vehicle_id AND t.day = k.day
      LEFT JOIN p ON p.vehicle_id = k.vehicle_id AND p.day = k.day
      LEFT JOIN f ON f.vehicle_id = k.vehicle_id AND f.day = k.day
      LEFT JOIN d ON d.vehicle_id = k.vehicle_id AND d.day = k.day
     ORDER BY k.vehicle_id, k.day`
  const litres = (ml: number | null) => (ml == null ? null : Math.round(Number(ml)) / 1000)
  return rows.map((r) => ({
    vehicleId: r.vehicle_id,
    day: r.day.toISOString().slice(0, 10),
    openingL: litres(r.opening_ml),
    closingL: litres(r.closing_ml),
    fillL: litres(r.fill_ml) ?? 0,
    drainL: litres(r.drain_ml) ?? 0,
  }))
}
