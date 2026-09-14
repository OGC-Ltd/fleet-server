/**
 * One unit's fuel day, day by day — the series behind the single-vehicle fuel
 * chart.
 *
 * ## Why this is not `fuel-rate-series` with a filter on it
 *
 * That service answers "is the YARD getting better or worse", and its floors
 * are sized for a yard: a day needs 200 km or 5 hectares before its rate is
 * published, because a fleet-wide denominator below that is arithmetic rather
 * than a measurement. Point it at one lorry and most days fall through the
 * floor — measured on the box 2026-09-14, MENENGAI's busiest unit averages 258
 * km a day and its median unit 140, so a 200 km floor silently deletes most of
 * the series for the unit an operator is actually looking at.
 *
 * So the floor here is a per-UNIT floor, and everything else — the guards, the
 * turbulence correction, the borrowed tank ceiling — is lifted unchanged. These
 * numbers have to agree with the fleet chart when the filter happens to name
 * every unit, and they only can if the arithmetic is the same arithmetic.
 *
 * ## The series is GAPPY, and that is the honest shape
 *
 * A measured tank balance exists only for a vehicle-day that clears the guards.
 * For a single unit that is 11 to 13 days in 30 (measured, MENENGAI, 30 days to
 * 2026-09-14) — not because the unit stood idle, but because a day needs an
 * hour of engine time, a probe reading inside its own tank, and a balance under
 * two tankfuls before anyone can say what it burnt.
 *
 * Every figure is therefore NULL rather than 0 on a day that did not qualify.
 * A zero would draw a bar to the axis and read as "this lorry burnt nothing",
 * which is a claim; null draws a gap, which is the absence of one.
 *
 * ## Litres per kilometre says nothing about a machine that digs
 *
 * Position freezes at speed 0 on this telemetry, so plant burns fuel while
 * reporting almost no distance. That is a real 7.5 L/km on a wheel loader and
 * it means nothing. The floor below keeps those days out of the rate rather
 * than letting them set the top of the axis.
 */

import { prisma } from '../../lib/prisma.js'
import { createWarmCache } from '../../lib/warm-cache.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { vehicleSql, windowCacheKey, parseWindowCacheKey, vehicleIdsFor } from './vehicle-filter.js'

/**
 * The guards the measured balance is taken under.
 *
 * Copied from `fuel-rate-series`, which copied them from
 * `fuel-burn-rate.service`, and deliberately still copies: each was earned by a
 * specific machine, and a shared import would let a change made for the fleet
 * chart move what one unit's history says without anyone deciding that.
 */
const MIN_ENGINE_SECONDS = 3600
const OVER_TANK = 1.1
const MAX_TANKFULS = 2

/**
 * The distance below which a day's litres-per-kilometre is not reported.
 *
 * Five kilometres, against the fleet series' two hundred. The fleet figure
 * divides one day's whole yard by one day's whole distance, so its denominator
 * is a sum over dozens of units; this one is a single unit's odometer, and the
 * same threshold would reject the ordinary working day it exists to describe.
 *
 * It is still a floor rather than nothing, because the days it removes are the
 * ones that produce the largest numbers: a unit that moved 1.2 km while burning
 * 2.8 L reports 2.6 L/km, and a wheel loader digging on the spot 7.5. Those are
 * arithmetic about a machine that does not travel to work.
 */
const MIN_KM_PER_DAY = 5

export interface VehicleFuelDay {
  day: string
  /** Measured burn — the tank's own balance, turbulence-corrected. Null on a
   *  day the guards rejected. */
  litres: number | null
  /** Engine hours behind that burn. */
  hours: number | null
  /** Distance integrated from the fixes, kilometres. */
  km: number | null
  /** Null below MIN_KM_PER_DAY — see the constant. */
  litresPerKm: number | null
  /** Available wherever `litres` is: the guard already required an hour. */
  litresPerHour: number | null
  /**
   * Units behind the row. One under a single-unit filter; more when the caller
   * widened the selection, and then every figure above is a fleet sum and the
   * rates are sum-over-sum. Carried so the client can say which it is drawing.
   */
  vehicles: number
}

export interface VehicleFuelSeries {
  days: VehicleFuelDay[]
  /** Days in the window that produced a measured balance at all. The series
   *  length is the window; this is how much of it is real. */
  measured: number
  windowDays: number
}

/** @param vehicleIds the resolved filter — see analytics/vehicle-filter. */
export async function vehicleFuelByDay(
  orgId: string, days = 30, to?: Date, vehicleIds: string[] | null = null,
): Promise<VehicleFuelSeries> {
  const anchor  = to ?? new Date()
  const lastDay = fleetDayKey(anchor)
  const fromDay = fleetDayKey(new Date(fleetDayStart(anchor).getTime() - (days - 1) * 86_400_000))
  const fromAt  = new Date(fleetDayStart(anchor).getTime() - days * 86_400_000)

  const rows = await prisma.$queryRaw<Array<{
    day: Date; vehicles: bigint; burn_l: number; km: number; hours: number
  }>>`
    -- The borrowed tank ceiling, org-scoped and never filter-scoped: the size
    -- of this fleet's tanks is a fact about the fleet, and it must not change
    -- because an operator picked one unit. See fuel-rate-series for the
    -- measurement behind the fallback.
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
           sum(coalesce(t.distance_m, 0))::float8 / 1000.0 AS km,
           sum(t.engine_seconds)::float8 / 3600.0          AS hours
      FROM t
      LEFT JOIN fills  f ON f.vehicle_id = t.vehicle_id AND f.day = t.day
      LEFT JOIN drains d ON d.vehicle_id = t.vehicle_id AND d.day = t.day
      CROSS JOIN LATERAL (
        SELECT ((coalesce(t.opening_ml, 0) - coalesce(t.closing_ml, 0))
                 + coalesce(f.refill_ml, 0) - coalesce(d.drain_ml, 0)) / 1000.0 AS raw_l
      ) b
      CROSS JOIN LATERAL (
        SELECT b.raw_l * greatest(0, least(1, 1 - ((t.turb_ml / 1000.0) / b.raw_l) ^ 2)) AS burn_l
      ) r
     WHERE t.cap > 0
       AND t.opening_ml / 1000.0 <= t.cap * ${OVER_TANK}
       AND b.raw_l > 0
       AND b.raw_l <= t.cap * ${MAX_TANKFULS}
       AND t.turb_ml / 1000.0 < b.raw_l
     GROUP BY 1
     ORDER BY 1`

  const measuredByDay = new Map(rows.map(r => [
    r.day.toISOString().slice(0, 10),
    { litres: r.burn_l, km: r.km, hours: r.hours, vehicles: Number(r.vehicles) },
  ]))

  // The WHOLE window, not only the days that measured. A chart drawn from
  // qualifying days alone would space eleven readings evenly across the axis
  // and read as a continuous history; the gaps are the point.
  const out: VehicleFuelDay[] = Array.from({ length: days }, (_, i) => {
    // `fleetDayKey` returns the fleet day as a Date at UTC midnight; the map
    // above is keyed by the same day's ISO date, which is what the client
    // joins on.
    const day = fleetDayKey(
      new Date(fleetDayStart(anchor).getTime() - (days - 1 - i) * 86_400_000),
    ).toISOString().slice(0, 10)
    const a = measuredByDay.get(day)
    if (!a || !(a.litres > 0)) {
      return {
        day, litres: null, hours: null, km: null,
        litresPerKm: null, litresPerHour: null, vehicles: a?.vehicles ?? 0,
      }
    }
    return {
      day,
      litres: Math.round(a.litres * 10) / 10,
      hours:  Math.round(a.hours * 10) / 10,
      km:     Math.round(a.km),
      litresPerKm: a.km >= MIN_KM_PER_DAY
        ? Math.round((a.litres / a.km) * 100) / 100
        : null,
      // The guard above already required an hour of engine time per unit, so
      // this divisor cannot be small enough to be noise.
      litresPerHour: a.hours > 0
        ? Math.round((a.litres / a.hours) * 10) / 10
        : null,
      vehicles: a.vehicles,
    }
  })

  return {
    days: out,
    measured: out.filter(d => d.litres != null).length,
    windowDays: days,
  }
}

/**
 * Cached beside the other windowed reads.
 *
 * `warmKeysFor` is omitted rather than emptied, so this cache never joins the
 * central warmer's registry at all: every key here carries a unit selection,
 * and a warmer cannot guess which unit somebody is about to open. Entries
 * arrive on demand and age out — the same treatment an ad-hoc filter already
 * gets on the other caches, and what `maxEntries` is for.
 */
const cache = createWarmCache<VehicleFuelSeries>({
  name: 'vehicle-fuel-days',
  refreshMs: 15 * 60_000,
  maxEntries: 200,
  compute: async (key) => {
    const { orgId, days, to, categories, vehicles } = parseWindowCacheKey(key)
    return vehicleFuelByDay(orgId, days, to, await vehicleIdsFor(orgId, categories, vehicles))
  },
})

export async function getVehicleFuelSeries(
  orgId: string, days = 30, to?: Date,
  categories: string[] | null = null, vehicles: string[] | null = null,
) {
  return cache.get(windowCacheKey(orgId, days, to, categories, vehicles))
}
