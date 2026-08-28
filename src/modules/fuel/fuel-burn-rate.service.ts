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
import { logger } from '../../lib/logger.js'
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

/**
 * Kilometres a day must cover before its litres-per-kilometre means anything.
 *
 * The hours side requires an hour of running for the same reason — a rate needs
 * a denominator, and days holding seconds of engine time produced 120,633 L/h
 * before that guard existed. Ten kilometres is the distance equivalent: at this
 * fleet's measured 1.5-3 km/L for trucks and lorries that is 3-7 litres burned,
 * enough to sit above the probe's own noise, while a two-kilometre yard shuffle
 * is not.
 */
const MIN_DISTANCE_M = 10_000

export interface MeasuredKmRate {
  /** Litres per kilometre — the median qualifying day. */
  lPerKm: number
  /** Qualifying days behind the figure. */
  days:   number
}

/**
 * What a machine ACTUALLY burns per kilometre, from the same tank balance.
 *
 * The hours version divides `burn = (opening - closing) + refills - drains` by
 * engine seconds; this divides the identical balance by ground covered. Same
 * guards, same turbulence correction, same median-over-days — only the
 * denominator differs, which is the whole point: a truck's work is travelling
 * and an excavator's is not.
 *
 * Meaningless on plant and not filtered out here. `resolveBasis` already decides
 * which figure is a machine's real one, and computing both for everything is
 * what lets the two be compared; PLANT measures 7.361 L/km, which is not a rate
 * anyone can use but is the arithmetic saying the denominator is wrong.
 *
 * ## Why this could not ship before 2026-08-27
 *
 * It divides by `distance_m`, which until that day had no jitter floor and no
 * plausibility test, and overstated SUKARI's ground covered by 35%. An inflated
 * denominator deflates L/km, and a deflated L/km makes a real loss look
 * explained by driving — the failure that produces silence rather than noise,
 * and therefore the one nobody reports. The guard had to land first.
 */
export async function measuredKmRates(
  orgId: string, days = 30,
): Promise<Map<string, MeasuredKmRate>> {
  const fromDay = fleetDayKey(
    new Date(fleetDayStart().getTime() - (days - 1) * 86_400_000),
  )
  const fromAt = new Date(fleetDayStart().getTime() - days * 86_400_000)

  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; days: bigint; lpk: number
  }>>`
    WITH t AS (
      SELECT t.vehicle_id, t.day, v.tank_capacity_litres AS cap,
             t.opening_ml, t.closing_ml, t.distance_m,
             abs(coalesce(t.turbulence_ml, 0)) AS turb_ml
        FROM fuel_daily_trends t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND t.day >= ${fromDay}
         AND t.distance_m >= ${MIN_DISTANCE_M}
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
           percentile_cont(0.5) WITHIN GROUP (ORDER BY r.lpk)::float8 AS lpk
      FROM t
      LEFT JOIN fills  f ON f.vehicle_id = t.vehicle_id AND f.day = t.day
      LEFT JOIN drains d ON d.vehicle_id = t.vehicle_id AND d.day = t.day
      CROSS JOIN LATERAL (
        SELECT ((coalesce(t.opening_ml, 0) - coalesce(t.closing_ml, 0))
                 + coalesce(f.refill_ml, 0) - coalesce(d.drain_ml, 0)) / 1000.0 AS burn_l
      ) b
      CROSS JOIN LATERAL (
        SELECT (b.burn_l * greatest(0, least(1, 1 - ((t.turb_ml / 1000.0) / b.burn_l) ^ 2)))
               / (t.distance_m / 1000.0) AS lpk
      ) r
     WHERE b.burn_l > 0
       AND b.burn_l <= t.cap * ${MAX_TANKFULS}
       AND t.turb_ml / 1000.0 < b.burn_l
     GROUP BY 1
    HAVING count(*) >= ${MIN_DAYS}`

  return new Map(rows.map(r => [r.vehicle_id, {
    lPerKm: Math.round(r.lpk * 1000) / 1000,
    days:   Number(r.days),
  }]))
}

export interface MeasuredPersistOutcome {
  /** Vehicles the balance produced a figure for, across every org. */
  measured: number
  /** Of those, the ones written onto an existing rate row. */
  stored:   number
  /** Measured figures with no rate row to attach to — see below. */
  orphaned: number
  /** Of the stored rows, how many also carry a measured litres-per-kilometre. */
  withKm:   number
}

/**
 * Persist the measured rates onto `vehicle_fuel_rates.measured_*`.
 *
 * ## Stored, and deliberately NOT judged on
 *
 * The plan's 3.6 proposed this measurement outrank the run-based derivation in
 * `resolveBand`. Measured against production on 2026-08-27, that is not
 * supported, and the numbers are worth keeping next to the code that would have
 * done it:
 *
 * | derived source | n | measured/derived p50 | within 1.5x | within 3x |
 * | --- | --- | --- | --- | --- |
 * | the machine's OWN rate | 58 | 0.77x | 51.7% | 96.6% |
 * | a TYPE MEDIAN | 36 | 0.43x | 19.4% | 61.1% |
 *
 * Against a machine's own derived rate the two agree about as well as two
 * honest methods can, with a systematic ~23% gap and no evidence which side of
 * it is right — the balance discounts turbulence and is conservative by
 * construction, while the derivation drops every run containing a refill and so
 * samples light-load work. Swapping which one judges would tighten expectations
 * by roughly a quarter and raise alert volume, on a coin toss.
 *
 * Against a type median the disagreement is wild (p50 0.43x) and the median is
 * plainly the weaker claim — but replacing 13.3 L/h with 2.4 would tighten
 * those bands four-fold, and with no labelled events there is nothing to say
 * whether that produces fewer false alerts or vastly more. And the coverage
 * argument fails outright: exactly ONE machine with no band today would gain
 * one.
 *
 * So the figures are stored, shown, and left out of the judgement until Stage 4
 * can say which is right. Storing a measurement costs nothing; acting on one
 * that disagrees with the incumbent 60% of the time is how a detector loses an
 * operator's trust.
 *
 * ## Why this only ever UPDATES
 *
 * `vehicle_fuel_rates.l_per_hour` is NOT NULL, so a row cannot exist for a
 * machine the run-based derivation never rated — and inventing an l_per_hour to
 * hang a measurement on would be fabricating the very number this column exists
 * to second-guess. Measured figures with nowhere to go are counted and
 * reported rather than forced in; at last count that is one machine.
 */
export async function persistMeasuredBurnRates(days = 30): Promise<MeasuredPersistOutcome> {
  const orgs = await prisma.organisation.findMany({ select: { id: true } })
  const measuredAt = new Date()
  const out: MeasuredPersistOutcome = { measured: 0, stored: 0, orphaned: 0, withKm: 0 }

  for (const org of orgs) {
    // The distance sibling, keyed the same way. A vehicle can have one figure
    // and not the other — a machine that burns while stationary covers no
    // qualifying distance, and a truck idling all week logs no engine hours
    // against a road rate — so they are looked up independently rather than
    // requiring both.
    const kmRates = await measuredKmRates(org.id, days)

    for (const [vehicleId, m] of await measuredBurnRates(org.id, days)) {
      out.measured++
      const km = kmRates.get(vehicleId)
      // updateMany, not update: a vehicle with no derived rate has no row, and
      // that is an expected outcome here rather than an error to throw on.
      const { count } = await prisma.vehicleFuelRate.updateMany({
        where: { vehicleId },
        data: {
          measuredLPerHour:   m.lPerHour,
          measuredLoLPerHour: m.loLPerHour,
          measuredHiLPerHour: m.hiLPerHour,
          measuredDays:       m.days,
          measuredAt,
          // Null where this machine covered no qualifying distance, which is
          // the honest answer for plant. Not defaulted to zero: a zero L/km
          // would read as "burns nothing while driving".
          measuredLPerKm:     km?.lPerKm ?? null,
        },
      })
      if (count > 0) { out.stored++; if (km != null) out.withKm++ }
      else out.orphaned++
    }
  }

  logger.info(out, 'Measured burn rates persisted')
  return out
}
