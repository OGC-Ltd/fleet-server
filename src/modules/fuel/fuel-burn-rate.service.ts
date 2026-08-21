/**
 * What a machine ACTUALLY burns per engine hour, measured from its tank.
 *
 * The operator's objection, 2026-08-21: the per-hour figures were not realistic
 * for heavy machinery. They were not, and the reason was worse than a bad
 * constant — `litresPerHour` on the fleet-state row is `engine_burn_ml` over
 * `engine_seconds`, and `engine_burn_ml` is itself a rate multiplied by those
 * same seconds (see `engineBurnMl` in fuel-rate.ts). Dividing returned the rate
 * the model was handed. It measured nothing.
 *
 * It read as plausible because most machines have no rate of their own: 689 of
 * 815 active vehicles borrow their org+type median, so on KASULU one value —
 * 9.7 L/h — sat on 13 excavators, 9 bulldozers, 2 graders and 2 wheel loaders
 * at once. A bulldozer and an excavator reporting the same figure to one
 * decimal place is not a coincidence, it is a fallback.
 *
 * ## The fuel balance
 *
 *     burn = (opening - closing) + refills - drains
 *
 * The refill term is what makes it work. `consumed_ml` alone is opening minus
 * closing, so ANY day a machine was refuelled reads as little or no
 * consumption — and those are exactly the days a hard-working machine has.
 * Over KASULU's last 30 days, adding refills back moved bulldozers from 8.7
 * L/h to 13.1 and raised the days behind the wheel-loader figure from 67 to
 * 115: the estimate improved and so did the evidence under it.
 *
 * Refills come from `fuel_fillings`, preferring `observed_rise_ml` over the
 * declared `filled_ml` — the balance is measured with the probe, so its inputs
 * should be too. Drains come from `fuel_thefts`: fuel that left the tank
 * without being burned is not consumption.
 *
 * ## Turbulence, and the guards
 *
 * The correction is the operator's own formula from `fuel-normalised-rate`,
 * discounting a day's burn by how much of it the probe could have invented,
 * clamped the same way — unclamped it inverts once turbulence exceeds the burn
 * and reports 123 litres on a day the tank rose.
 *
 * Four physical guards sit around it, each earned by a machine that broke
 * without it:
 *
 *  · **an hour of running.** A rate needs a denominator. Days holding seconds
 *    of engine time produced 120,633 L/h before this.
 *
 *  · **the probe reads inside its own tank.** `MUFINDI: DZ 16` has a 540 L
 *    tank and reported levels of 4,564 to 7,184 L — thirteen tankfuls — so its
 *    "consumption" of 2,160 L in a day gave a median of 311 L/h. That is a
 *    miscalibrated probe, not a thirsty dozer. It is excluded rather than
 *    capped, because the machine has no measurement at all, not an extreme one.
 *
 *  · **at most two tankfuls a day.** The balance can still be wrong if a refill
 *    is double-counted; no machine burns more than that.
 *
 *  · **signal above noise.** Turbulence at or above the day's burn means the
 *    probe moved at least as much as the tank did.
 *
 * ## The median, not the mean
 *
 * Per vehicle, over qualifying days, at least MIN_DAYS of them. One bad day
 * survives every guard occasionally; a median does not care, where a mean over
 * a machine's month lets a single mis-parsed refill set the figure.
 *
 * Measured against production 2026-08-21: 58 ms.
 */

import { prisma } from '../../lib/prisma.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'

/** A rate needs a denominator; below an hour the division is noise. */
const MIN_ENGINE_SECONDS = 3600
/** Days behind a vehicle's figure before it describes the vehicle. */
const MIN_DAYS = 3
/** Headroom over declared capacity before a probe is calling itself a liar.
 *  A tank reads a little over full after a brim fill; it does not read 13x. */
const OVER_TANK = 1.1
/** A day's burn ceiling, in tankfuls. Guards a double-counted refill. */
const MAX_TANKFULS = 2

export interface MeasuredBurnRate {
  /** Litres per engine hour — the median qualifying day. */
  lPerHour: number
  /** The range those days span, so a caller can show what the figure rests on. */
  loLPerHour: number
  hiLPerHour: number
  /** Qualifying days behind the figure. */
  days: number
}

/**
 * Measured burn rates for one org's active vehicles, keyed by vehicle id.
 *
 * A vehicle absent from the map has no measurable rate — no probe, a probe
 * reading outside its own tank, or too few clean days. Absent is the honest
 * answer, and callers must not substitute a type median for it: that
 * substitution is the thing this service exists to undo.
 */
export async function measuredBurnRates(
  orgId: string, days = 30,
): Promise<Map<string, MeasuredBurnRate>> {
  // Fleet days, via fleetDayKey — the only sanctioned instant-to-date
  // conversion here. A raw `::date` in a UTC session yields the PREVIOUS
  // calendar date for a fleet day that begins at 21:00 UTC, which has widened
  // three windows in this codebase already.
  const fromDay = fleetDayKey(
    new Date(fleetDayStart().getTime() - (days - 1) * 86_400_000),
  )
  const fromAt = new Date(fleetDayStart().getTime() - days * 86_400_000)

  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; days: bigint; lph: number; lo: number; hi: number
  }>>`
    WITH t AS (
      SELECT t.vehicle_id, t.day, v.tank_capacity_litres AS cap,
             t.opening_ml, t.closing_ml, t.engine_seconds,
             abs(coalesce(t.turbulence_ml, 0)) AS turb_ml
        FROM fuel_daily_trends t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND t.day >= ${fromDay}
         AND t.engine_seconds >= ${MIN_ENGINE_SECONDS}
         AND v.tank_capacity_litres > 0
         AND t.opening_ml / 1000.0 <= v.tank_capacity_litres * ${OVER_TANK}
    ),
    fills AS (
      SELECT f.vehicle_id, (f.filled_at + interval '3 hours')::date AS day,
             sum(coalesce(f.observed_rise_ml, f.filled_ml)) AS refill_ml
        FROM fuel_fillings f
        JOIN vehicles v ON v.id = f.vehicle_id
       WHERE v.organisation_id = ${orgId} AND f.filled_at >= ${fromAt}
       GROUP BY 1, 2
    ),
    drains AS (
      SELECT th.vehicle_id, (th.detected_at + interval '3 hours')::date AS day,
             sum(greatest(0, th.initial_fuel_level_ml - th.final_fuel_level_ml)) AS drain_ml
        FROM fuel_thefts th
        JOIN vehicles v ON v.id = th.vehicle_id
       WHERE v.organisation_id = ${orgId} AND th.detected_at >= ${fromAt}
       GROUP BY 1, 2
    )
    SELECT t.vehicle_id,
           count(*)::bigint AS days,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY r.lph)::float8 AS lph,
           min(r.lph)::float8 AS lo,
           max(r.lph)::float8 AS hi
      FROM t
      LEFT JOIN fills  f ON f.vehicle_id = t.vehicle_id AND f.day = t.day
      LEFT JOIN drains d ON d.vehicle_id = t.vehicle_id AND d.day = t.day
      CROSS JOIN LATERAL (
        SELECT ((coalesce(t.opening_ml, 0) - coalesce(t.closing_ml, 0))
                 + coalesce(f.refill_ml, 0) - coalesce(d.drain_ml, 0)) / 1000.0 AS burn_l
      ) b
      CROSS JOIN LATERAL (
        SELECT (b.burn_l * greatest(0, least(1, 1 - ((t.turb_ml / 1000.0) / b.burn_l) ^ 2)))
               / (t.engine_seconds / 3600.0) AS lph
      ) r
     WHERE b.burn_l > 0
       AND b.burn_l <= t.cap * ${MAX_TANKFULS}
       AND t.turb_ml / 1000.0 < b.burn_l
     GROUP BY 1
    HAVING count(*) >= ${MIN_DAYS}`

  const r1 = (n: number) => Math.round(n * 10) / 10
  return new Map(rows.map(r => [r.vehicle_id, {
    lPerHour:   r1(r.lph),
    loLPerHour: r1(r.lo),
    hiLPerHour: r1(r.hi),
    days:       Number(r.days),
  }]))
}
