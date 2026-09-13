/**
 * What the fleet spends per unit of work, day by day.
 *
 * ## The numerator is MEASURED from the tank, and was not always
 *
 * Until 2026-08-28 this summed `engine_burn_ml`, which is modelled — a rate
 * times engine hours, where the rate is borrowed from an org+type median for
 * most of the fleet (`vehicle_fuel_rates` covers 238 of 815 active vehicles).
 * So the chart divided a model's output by a measured denominator and drew the
 * quotient as what work cost. The histogram beside it already refused that same
 * field, for the same reason, and said so in its own header.
 *
 * It was not a small difference. Measured over 30 days, modelled against
 * measured on the same days:
 *
 *     KASULU   1.4x - 1.6x        SUKARI   2.2x - 3.4x
 *
 * The modelled series also wanders where the measured one does not: SUKARI's
 * measured L/km sat between 0.47 and 0.56 across every day in the window while
 * the modelled figure swung 0.74 to 1.21. A chart meant to answer "is the yard
 * getting better or worse" cannot be built on the noisier of the two.
 *
 * The numerator now closes the tank's own balance —
 * (opening - closing) + refills - drains — turbulence-corrected, under the four
 * physical guards `fuel-burn-rate.service` earned the hard way. It is the same
 * arithmetic behind `litresPerHourMeasured`, which is the figure the fleet
 * table already trusts.
 *
 * ## Numerator and denominator describe ONE population
 *
 * A measured balance only exists for a vehicle-day that clears those guards —
 * 77 of 218 active vehicles on an average KASULU day. So the distance and the
 * ground are summed over exactly those same qualifying vehicle-days, never over
 * the whole fleet. Dividing a partial numerator by a total denominator would
 * understate the rate by the coverage fraction and quietly redefine it every
 * time coverage moved.
 *
 * That makes this "what the machines we can measure spend per unit of their own
 * work", and `vehicles` carries the count so a reader can see the population
 * rather than assume it is the yard.
 *
 * ## The tank ceiling is BORROWED when a unit has none, and only as a ceiling
 *
 * Two of the guards below need a tank size: a probe must not read more than its
 * own tank, and a day must not burn more than two tankfuls. `tank_capacity_litres`
 * is the only source of that, and it is not a field the provider sends — the
 * operator writes the size into the Wialon fuel sensor's NAME ("Main Tank Fuel
 * Level Qty (450L)") and `prisma/sync-wialon` reads it back out. So the column
 * is populated exactly as well as that account is labelled.
 *
 * Measured on the box, 2026-09-13, over a 30-day window:
 *
 *     MENENGAI    244 active   208 in trends   194 ran an hour+   8 stated a tank
 *     WESTSUGAR   486 active   280 in trends   257 ran an hour+ 295 stated a tank
 *
 * Requiring the unit's OWN capacity therefore threw away 99% of Menengai: the
 * chart was drawn from 3 units and 15 vehicle-days against West Kenya's 194,
 * while Menengai's trends carried 268,863 measured kilometres over the same
 * window. Not a thin population — the wrong one.
 *
 * So a unit with no stated tank borrows the MEDIAN stated tank of its own
 * organisation and vehicle type, and failing that its organisation's. This is a
 * model, and the header above rejects modelled inputs — the distinction is that
 * this one never enters an answer. It is a rejection threshold: the litres are
 * still the tank's own balance and the kilometres are still integrated from the
 * fixes, and a borrowed ceiling can only decide whether a day is admitted, not
 * what that day says.
 *
 * The same measurement, with the fallback:
 *
 *     MENENGAI      3 units → 183     0.560 → 0.416 L/km
 *     WESTSUGAR   194 units → 220     0.844 → 0.782 L/km
 *
 * West Kenya is the control: it barely needs the fallback (26 of its 220 units
 * borrow), and the guards keep doing their job — the worst admitted day falls
 * from 6,313 L to 440 L, because a borrowed ceiling still rejects an impossible
 * balance where no ceiling at all would have let it through.
 *
 * The real repair is upstream — a tank size in every sensor name, or a provider
 * field carrying it — and this does not remove the need for it.
 *
 * Read the kilometre view knowing what is in it: plant that digs all day
 * reports almost no distance while burning, because position freezes at speed 0
 * on this telemetry. That fuel still lands in the numerator, so the kilometre
 * figure is the cost per kilometre of driving DONE, not a lorry's consumption
 * rate. The hectare view is the one to read on a digging day.
 *
 * ## Why a daily series rather than one number
 *
 * The per-machine figures on the fleet table answer "which machine is
 * expensive". This answers "is the yard getting better or worse", which a
 * single average cannot: measured over KASULU's last twelve days the hectare
 * rate ran across a twofold spread that averages away to a number nobody would
 * question.
 *
 * ## The annotations are computed, never authored
 *
 * The band is the mean plus and minus one standard deviation of the series
 * itself, and the marked day is the series' own worst. Nothing here is a
 * hand-placed note about an event somebody remembered — a chart that ships with
 * invented annotations is a chart that lies the first time the data moves.
 */

import { prisma } from '../../lib/prisma.js'
import { createWarmCache } from '../../lib/warm-cache.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { vehicleSql, windowCacheKey, parseWindowCacheKey, vehicleIdsFor } from './vehicle-filter.js'

/**
 * Denominators below which a day's rate is arithmetic, not a measurement.
 *
 * The window's first day is usually thin — telemetry history starts mid-day, so
 * a hectare of ground can survive into the series and produce a rate several
 * times the mean. Measured 2026-08-21, KASULU's 2026-07-27 came
 * back at 370.7 L/ha off 1.04 ha, against a 30-day mean of 102.7, and it would
 * have been the day the chart pointed at.
 *
 * Same guard, and the same reason, as MIN_DIG_FIXES in excavator-area: a
 * denominator too small to divide by is not a small number, it is no number.
 */
const MIN_HECTARES = 5
const MIN_KM = 200

/**
 * The guards the measured balance is taken under.
 *
 * Copied deliberately from `fuel-burn-rate.service` rather than imported: they
 * are not exported there, and each was earned by a specific machine — an hour
 * of running so the division is not noise, a probe reading inside its own tank
 * (`MUFINDI: DZ 16` reported thirteen tankfuls), and a ceiling of two tankfuls
 * a day to catch a double-counted refill. If those move, these must move too.
 */
const MIN_ENGINE_SECONDS = 3600
const OVER_TANK = 1.1
const MAX_TANKFULS = 2

export interface FuelRateDay {
  day: string
  /** The day's whole fuel bill over the whole day's ground. Null where nobody
   *  measured enough ground to divide by. */
  litresPerHectare: number | null
  /** The same fuel bill over the whole day's distance. */
  litresPerKm: number | null
  /** The denominators and the numerator, so a reader can see what a rate rests
   *  on rather than having to trust the quotient. */
  hectares: number | null
  km: number | null
  litres: number | null
  /**
   * Machines whose tank balance closed that day — the population every other
   * figure on this row describes.
   *
   * Carried because the rate is not the yard's: a measured balance exists only
   * for a vehicle-day clearing the guards, 77 of 218 active on an average
   * KASULU day. A reader who takes this for the whole fleet is reading a
   * different number than the one drawn.
   */
  vehicles: number
}

/** Mean, spread, and the day worth asking about — all read off the series. */
export interface RateStats {
  mean:  number | null
  /** Mean ± 1 SD. The band an ordinary day sits in. */
  bandLow:  number | null
  bandHigh: number | null
  /** The series' own worst day, for the point marker. */
  peakDay:   string | null
  peakValue: number | null
  /** How many days carried a figure at all. */
  measured: number
}

export interface FuelRateSeries {
  days: FuelRateDay[]
  perHectare: RateStats
  perKm:      RateStats
  windowDays: number
}

function statsOf(values: Array<{ day: string; v: number }>): RateStats {
  if (values.length === 0) {
    return { mean: null, bandLow: null, bandHigh: null, peakDay: null, peakValue: null, measured: 0 }
  }
  const r1   = (n: number) => Math.round(n * 10) / 10
  const mean = values.reduce((a, x) => a + x.v, 0) / values.length
  // Population SD: this is the whole window, not a sample drawn from it.
  const sd   = Math.sqrt(values.reduce((a, x) => a + (x.v - mean) ** 2, 0) / values.length)
  const peak = values.reduce((a, x) => (x.v > a.v ? x : a), values[0]!)
  return {
    mean:      r1(mean),
    bandLow:   r1(Math.max(0, mean - sd)),
    bandHigh:  r1(mean + sd),
    peakDay:   peak.day,
    peakValue: r1(peak.v),
    measured:  values.length,
  }
}

/** @param vehicleIds the vehicle-type filter, resolved to ids — see
 *  analytics/vehicle-filter. Null is unfiltered. */
export async function fuelRateByDay(
  orgId: string, days = 30, to?: Date, vehicleIds: string[] | null = null,
): Promise<FuelRateSeries> {
  // Anchored the way every other windowed figure on this page is anchored:
  // today plus the days - 1 complete days behind it, in fleet days.
  const anchor  = to ?? new Date()
  const lastDay = fleetDayKey(anchor)
  const fromDay = fleetDayKey(new Date(fleetDayStart(anchor).getTime() - (days - 1) * 86_400_000))

  // Instants, for the fill/drain windows — those tables carry timestamps, not
  // fleet days, and are bucketed the way fuel-burn-rate buckets them.
  const fromAt = new Date(fleetDayStart(anchor).getTime() - days * 86_400_000)

  // One query, because numerator and denominators have to come from the SAME
  // qualifying vehicle-days — see the header. Every guard and the turbulence
  // correction are lifted from fuel-burn-rate.measuredBurnRates unchanged; if
  // that service's thresholds move, this must move with them.
  const rows = await prisma.$queryRaw<Array<{
    day: Date; vehicles: bigint; burn_l: number; km: number; ha: number
  }>>`
    -- The ceiling a unit's day is sanity-checked against, where the unit has no
    -- stated tank size of its own. The service header carries the argument and
    -- the measurement behind it.
    --
    -- Median rather than mean: the stated capacities inside one org and type
    -- are not clean (Sukari's range down to a litre), and a mean would let one
    -- mis-typed sensor name move the ceiling for every unit borrowing it.
    --
    -- Scoped to the ORGANISATION and never to the vehicle filter: the ceiling is
    -- a fact about what this fleet's tanks are, and it must not change because
    -- an operator ticked a category on the filter bar.
    WITH med_type AS (
      SELECT mv.vehicle_type,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY mv.tank_capacity_litres) AS cap
        FROM vehicles mv
       WHERE mv.organisation_id = ${orgId} AND mv.is_active
         AND mv.tank_capacity_litres > 0
       GROUP BY 1
    ),
    med_org AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mv.tank_capacity_litres) AS cap
        FROM vehicles mv
       WHERE mv.organisation_id = ${orgId} AND mv.is_active
         AND mv.tank_capacity_litres > 0
    ),
    t AS (
      SELECT t.vehicle_id, t.day,
             coalesce(nullif(v.tank_capacity_litres, 0), med_type.cap, med_org.cap) AS cap,
             t.opening_ml, t.closing_ml, t.engine_seconds, t.distance_m,
             abs(coalesce(t.turbulence_ml, 0)) AS turb_ml
        FROM fuel_daily_trends t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN med_type ON med_type.vehicle_type = v.vehicle_type
        CROSS JOIN med_org
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND t.day >= ${fromDay} AND t.day <= ${lastDay}
         AND t.engine_seconds >= ${MIN_ENGINE_SECONDS}
         ${vehicleSql(vehicleIds)}
    ),
    fills AS (
      SELECT f.vehicle_id, (f.filled_at + interval '3 hours')::date AS day,
             sum(coalesce(f.observed_rise_ml, f.filled_ml)) AS refill_ml
        FROM fuel_fillings f
        JOIN vehicles v ON v.id = f.vehicle_id
       WHERE v.organisation_id = ${orgId} AND f.filled_at >= ${fromAt}
         ${vehicleSql(vehicleIds)}
       GROUP BY 1, 2
    ),
    drains AS (
      SELECT th.vehicle_id, (th.detected_at + interval '3 hours')::date AS day,
             sum(greatest(0, th.initial_fuel_level_ml - th.final_fuel_level_ml)) AS drain_ml
        FROM fuel_thefts th
        JOIN vehicles v ON v.id = th.vehicle_id
       WHERE v.organisation_id = ${orgId} AND th.detected_at >= ${fromAt}
         ${vehicleSql(vehicleIds)}
       GROUP BY 1, 2
    )
    SELECT t.day,
           count(*)::bigint AS vehicles,
           sum(r.burn_l)::float8 AS burn_l,
           sum(coalesce(t.distance_m, 0))::float8 / 1000.0    AS km,
           sum(coalesce(s.dig_area_m2, 0))::float8 / 10000.0  AS ha
      FROM t
      LEFT JOIN fills  f ON f.vehicle_id = t.vehicle_id AND f.day = t.day
      LEFT JOIN drains d ON d.vehicle_id = t.vehicle_id AND d.day = t.day
      LEFT JOIN vehicle_daily_stats s ON s.vehicle_id = t.vehicle_id AND s.day = t.day
      CROSS JOIN LATERAL (
        SELECT ((coalesce(t.opening_ml, 0) - coalesce(t.closing_ml, 0))
                 + coalesce(f.refill_ml, 0) - coalesce(d.drain_ml, 0)) / 1000.0 AS raw_l
      ) b
      CROSS JOIN LATERAL (
        SELECT b.raw_l * greatest(0, least(1, 1 - ((t.turb_ml / 1000.0) / b.raw_l) ^ 2)) AS burn_l
      ) r
     WHERE t.cap > 0
       -- Moved down out of the t CTE, which could not see the borrowed
       -- ceiling. Same guard, same threshold: a probe reading more than its own
       -- tank is reporting a fault, not a level.
       AND t.opening_ml / 1000.0 <= t.cap * ${OVER_TANK}
       AND b.raw_l > 0
       AND b.raw_l <= t.cap * ${MAX_TANKFULS}
       AND t.turb_ml / 1000.0 < b.raw_l
     GROUP BY 1
     ORDER BY 1`

  const acc = new Map(rows.map(r => [
    r.day.toISOString().slice(0, 10),
    { litres: r.burn_l, km: r.km, ha: r.ha, vehicles: Number(r.vehicles) },
  ]))

  const keys = [...acc.keys()].sort()
  const out: FuelRateDay[] = keys.map((day) => {
    const a  = acc.get(day)
    // Zero hectares means nothing dug that day, not a missing reading — the
    // area column is null only where the geometry could not be drawn, and the
    // sum coalesces it. Below the floor it is not a denominator either way.
    const ha = a && a.ha > 0 ? a.ha : null
    // Null, never zero, where the denominator is absent. A zero would draw a
    // line down to the axis on a day nobody measured, which reads as a day the
    // fleet worked for nothing.
    return {
      day,
      litresPerHectare: a && ha != null && ha >= MIN_HECTARES && a.litres > 0
        ? Math.round((a.litres / ha) * 10) / 10 : null,
      litresPerKm: a && a.km >= MIN_KM && a.litres > 0
        ? Math.round((a.litres / a.km) * 100) / 100 : null,
      hectares: ha == null ? null : Math.round(ha * 10) / 10,
      km:       a && a.km > 0 ? Math.round(a.km) : null,
      litres:   a && a.litres > 0 ? Math.round(a.litres) : null,
      vehicles: a?.vehicles ?? 0,
    }
  })

  return {
    days: out,
    perHectare: statsOf(out.filter(d => d.litresPerHectare != null)
      .map(d => ({ day: d.day, v: d.litresPerHectare! }))),
    perKm: statsOf(out.filter(d => d.litresPerKm != null)
      .map(d => ({ day: d.day, v: d.litresPerKm! }))),
    windowDays: days,
  }
}

/** Cached beside the other windowed reads: the answer is a stack of completed
 *  days plus today, and today only moves as the rollup does. */
const cache = createWarmCache<FuelRateSeries>({
  name: 'fuel-rate-series',
  refreshMs: 15 * 60_000,
  maxEntries: 200,
  warmKeysFor: (orgId) => [windowCacheKey(orgId, 30, undefined, null)],
  compute: async (key) => {
    const { orgId, days, to, categories, vehicles } = parseWindowCacheKey(key)
    return fuelRateByDay(orgId, days, to, await vehicleIdsFor(orgId, categories, vehicles))
  },
})

export async function getFuelRateSeries(
  orgId: string, days = 30, to?: Date,
  categories: string[] | null = null, vehicles: string[] | null = null,
) {
  return cache.get(windowCacheKey(orgId, days, to, categories, vehicles))
}
