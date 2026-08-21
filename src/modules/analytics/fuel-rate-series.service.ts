/**
 * What the fleet spends per unit of work, day by day.
 *
 * ## One numerator, two denominators
 *
 * The numerator is EVERY litre the fleet burned that day — excavators, dozers,
 * loaders, lorries, tankers, the lot. The denominators are the whole day's work
 * measured two ways: all the ground covered, and all the distance driven. So
 * the two views are not two populations, they are one day's fuel bill asked
 * about twice — what a day of work cost per hectare, and what it cost per
 * kilometre.
 *
 * An earlier cut of this split the numerator too, charging only excavator fuel
 * against hectares and only travel fuel against kilometres. That answers a
 * narrower question than the one asked, and it left the dozers and loaders —
 * which burn real fuel over the same ground — out of the hectare figure
 * entirely.
 *
 * Read the kilometre view knowing what is in it: plant that digs all day
 * reports almost no distance while burning, because position freezes at speed 0
 * on this telemetry. That fuel still lands in the numerator, so the kilometre
 * figure is the fleet's cost per kilometre of driving DONE, not a lorry's
 * consumption rate. The hectare view is the one to read on a digging day.
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
import { vehicleSql, windowCacheKey, parseWindowCacheKey, vehicleIdsForCategories } from './vehicle-filter.js'

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

  const [burn, area] = await Promise.all([
    prisma.$queryRaw<Array<{ day: Date; burn_ml: number; distance_m: number }>>`
      SELECT t.day,
             sum(coalesce(t.engine_burn_ml, 0))::float8 AS burn_ml,
             sum(coalesce(t.distance_m, 0))::float8     AS distance_m
        FROM fuel_daily_trends t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND t.day >= ${fromDay} AND t.day <= ${lastDay}
         ${vehicleSql(vehicleIds)}
       GROUP BY 1`,
    prisma.$queryRaw<Array<{ day: Date; m2: number }>>`
      SELECT s.day, sum(s.dig_area_m2)::float8 AS m2
        FROM vehicle_daily_stats s
        JOIN vehicles v ON v.id = s.vehicle_id
       WHERE v.organisation_id = ${orgId} AND v.is_active
         AND s.dig_area_m2 IS NOT NULL
         AND s.day >= ${fromDay} AND s.day <= ${lastDay}
         ${vehicleSql(vehicleIds)}
       GROUP BY 1`,
  ])

  const hectaresByDay = new Map(area.map(a => [a.day.toISOString().slice(0, 10), a.m2 / 10_000]))

  // The whole fleet's day, undivided: every litre and every kilometre, whatever
  // the machine was. Both queries already aggregate per day, so this is just a
  // keyed lookup rather than a fold.
  const acc = new Map<string, { litres: number; km: number }>(
    burn.map(b => [
      b.day.toISOString().slice(0, 10),
      { litres: b.burn_ml / 1000, km: b.distance_m / 1000 },
    ]),
  )

  const keys = [...new Set([...acc.keys(), ...hectaresByDay.keys()])].sort()
  const out: FuelRateDay[] = keys.map((day) => {
    const a  = acc.get(day)
    const ha = hectaresByDay.get(day) ?? null
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
    const { orgId, days, to, categories } = parseWindowCacheKey(key)
    return fuelRateByDay(orgId, days, to, await vehicleIdsForCategories(orgId, categories))
  },
})

export async function getFuelRateSeries(
  orgId: string, days = 30, to?: Date, categories: string[] | null = null,
) {
  return cache.get(windowCacheKey(orgId, days, to, categories))
}
