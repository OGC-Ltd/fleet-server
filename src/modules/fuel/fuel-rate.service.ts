/**
 * Derive and store each vehicle's litres-per-engine-hour.
 *
 * The rule is in `fuel-rate.ts` and is pure; this is the plumbing. It implements
 * `docs/fuel-consumption-rates.md` §7.1 — *"persist per-vehicle rates, a table
 * keyed by vehicle, refreshed on a schedule rather than computed on the request
 * path"* — and the query below is that document's §6 derivation, unchanged
 * except for its window being a parameter.
 *
 * ## Rates come from engine-on RUNS, not per-ping deltas
 *
 * Summing positive level deltas accumulates probe noise into fictional
 * consumption: on a probe that swings 25 L parked, a day of noise adds up to a
 * tankful that never existed. Taking the level at the two ends of a long run
 * does not. A run qualifies when it has the engine on, ≥10 readings and ≥20
 * minutes, ends between 0.3 L and 200 L lower than it started, and contains
 * NEITHER a `fuel_fillings` row (a refuel invalidates the endpoints) NOR a
 * `fuel_thefts` row — a drain must never calibrate the expectation it will
 * later be compared against.
 *
 * ## Why this is not on the request path, and not nightly either
 *
 * It sorts the whole fuel-carrying telemetry window per vehicle. The instance
 * has ~1 GB of RAM for a 5.9 GB database, which is the reason the published
 * measurement used a three-day window rather than the thirty days it should
 * eventually stand on. A consumption rate moves over weeks — a machine does not
 * change what it burns between Tuesday and Wednesday — so this runs WEEKLY, and
 * the daily trend rows simply read whatever the table currently holds.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { MIN_RUNS, resolveRates, type RateGroup, type ResolvedRate, type VehicleRate } from './fuel-rate.js'

/**
 * Days of telemetry the derivation reads.
 *
 * THREE, because three is the only window this has been shown to survive on
 * this instance — `fuel-consumption-rates.md` §5 records it, and records that
 * thirty days is what per-vehicle rates should properly be built on. Widening
 * it is a deliberate act with someone watching the box, not a default: the
 * window functions here sort the full fuel-carrying set, on a t3.micro that is
 * already swapping beside a 1 GB RDS.
 *
 * At three days, coverage is 21 of 27 KASULU PLANT and 48 of 76 SUKARI
 * tractors at MIN_RUNS. The rest fall back to their type median, which is
 * exactly what the fallback exists for.
 */
export const RATE_WINDOW_DAYS = 3

/** Longest gap that can sit inside one run, in seconds. Beyond it the run cuts. */
const MAX_RUN_GAP_SECONDS = 900

/**
 * Litres per hour above which a figure is not a machine burning fuel.
 *
 * The derivation bounds a run's DROP — 0.3 L to 200 L — but bounding a drop is
 * not the same as bounding a rate, and until 2026-08-14 nothing bounded the
 * rate. A twenty-minute run that falls 100 L implies **300 L/h** and passed
 * every filter.
 *
 * That is not hypothetical, and it correlates with tank size exactly as you
 * would expect if the cause is probe noise rather than fuel:
 *
 * | unit | tank | derived |
 * | --- | --- | --- |
 * | `MUFINDI - DG 12` | 1696 L | **109.89 L/h** |
 * | `MUFINDI - CTR 07` | 1081 L | 97.87 L/h |
 * | `MUFINDI: CTR 23` | 1631 L | 32.29 L/h over 18 runs |
 *
 * A bigger tank makes a probe's proportional swing bigger in absolute litres,
 * so the 200 L drop ceiling stops constraining anything. `CTR 23` is the
 * instructive one: 18 runs, so this is not one bad afternoon but a probe
 * reading high consistently — which is precisely the failure
 * `fuel-consumption-rates.md` §5 warns about, a rate derived from the same
 * probe it will be compared against, self-consistent and wrong.
 *
 * Forty is a PLAUSIBILITY bound, not a model: the largest measured type
 * aggregate on this fleet is 12.47 L/h (Kasulu TRACTOR) and an excavator runs
 * about 11, so 40 is over three times the heaviest class anyone has measured.
 * It excludes 3 of 124 derived rates and nothing that looks like a machine.
 *
 * Applied PER RUN as well as to the result, so one impossible run is discarded
 * instead of dragging an otherwise sound vehicle over the line.
 */
export const MAX_PLAUSIBLE_L_PER_HOUR = 40

export interface RateDerivationOptions {
  /** Days of telemetry to read. Defaults to RATE_WINDOW_DAYS — read its note. */
  days?:  number
  /** False makes the call a dry run that derives and reports but stores nothing. */
  apply:  boolean
}

export interface RateDerivationOutcome {
  windowDays: number
  /** Vehicles the query produced any rate for, at any run count. */
  derived:    number
  /** Of those, the ones clearing MIN_RUNS — the rates that will actually be used. */
  usable:     number
  stored:     number
  /** Stored rows deleted for exceeding MAX_PLAUSIBLE_L_PER_HOUR. See below. */
  pruned:     number
}

/**
 * Re-derive every vehicle's rate from the last `days` of telemetry.
 *
 * Idempotent: upserts on vehicleId, so a re-run corrects rather than
 * duplicates. Vehicles the window produced nothing for keep their previous row
 * — a machine that sat idle all week has not lost the rate it was measured at,
 * and deleting it would silently move every one of its expectations onto a type
 * median.
 */
export async function deriveFuelRates(
  { days = RATE_WINDOW_DAYS, apply }: RateDerivationOptions,
): Promise<RateDerivationOutcome> {
  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; runs: bigint; l_per_hour: number; l_per_km: number | null
  }>>`
    WITH s AS (
      SELECT x.vehicle_id, x.captured_at, x.fuel_level_ml, x.engine_on,
             COALESCE(x.speed_kmh, 0) AS spd,
             lag(x.captured_at) OVER w AS prev_at,
             lag(x.engine_on)   OVER w AS prev_on
        FROM vehicle_telemetries x
       -- Cast explicit: make_interval takes an int, and a driver that binds the
       -- parameter as numeric or bigint would fail to resolve the function.
       WHERE x.captured_at >= now() - make_interval(days => ${days}::int)
         AND x.fuel_level_ml IS NOT NULL
      WINDOW w AS (PARTITION BY x.vehicle_id ORDER BY x.captured_at)
    ), b AS (
      SELECT *, extract(epoch FROM (captured_at - prev_at)) AS dt,
             sum(CASE WHEN prev_on IS DISTINCT FROM engine_on OR prev_at IS NULL
                        OR extract(epoch FROM (captured_at - prev_at)) > ${MAX_RUN_GAP_SECONDS}
                      THEN 1 ELSE 0 END)
               OVER (PARTITION BY vehicle_id ORDER BY captured_at) AS grp
        FROM s
    ), runs AS (
      SELECT vehicle_id, grp, bool_and(engine_on) AS eng,
             min(captured_at) AS t0, max(captured_at) AS t1, count(*) AS n,
             extract(epoch FROM (max(captured_at) - min(captured_at))) / 3600.0 AS hours,
             sum(CASE WHEN dt BETWEEN 1 AND ${MAX_RUN_GAP_SECONDS} THEN spd * dt / 3600.0 ELSE 0 END) AS km,
             (array_agg(fuel_level_ml ORDER BY captured_at))[1]      AS l0,
             (array_agg(fuel_level_ml ORDER BY captured_at DESC))[1] AS l1
        FROM b GROUP BY 1, 2
    ), clean AS (
      SELECT r.*, (r.l0 - r.l1) / 1000.0 AS litres FROM runs r
       WHERE r.eng AND r.n >= 10 AND r.hours >= 0.33
         AND r.l0 > r.l1 AND (r.l0 - r.l1) BETWEEN 300 AND 200000
         -- Bound the implied RATE, not only the drop. r.hours >= 0.33 above
         -- makes the division safe. See MAX_PLAUSIBLE_L_PER_HOUR: a 20-minute
         -- run falling 100 L implies 300 L/h and cleared every other filter.
         AND ((r.l0 - r.l1) / 1000.0) / r.hours <= ${MAX_PLAUSIBLE_L_PER_HOUR}
         AND NOT EXISTS (SELECT 1 FROM fuel_fillings f
                          WHERE f.vehicle_id = r.vehicle_id AND f.filled_at BETWEEN r.t0 AND r.t1)
         AND NOT EXISTS (SELECT 1 FROM fuel_thefts t
                          WHERE t.vehicle_id = r.vehicle_id AND t.began_at BETWEEN r.t0 AND r.t1)
    )
    SELECT c.vehicle_id, count(*) AS runs,
           round((sum(c.litres) / nullif(sum(c.hours), 0))::numeric, 2)::float8 AS l_per_hour,
           round((sum(c.litres) / nullif(sum(c.km),    0))::numeric, 3)::float8 AS l_per_km
      FROM clean c GROUP BY 1
     HAVING sum(c.hours) > 0
        -- Backstop: a vehicle whose every run is individually plausible can
        -- still aggregate to something that is not. Excluding it here is
        -- deliberate — no rate at all beats a wrong one, because the fallback
        -- below it (its type's median) is built from machines that were
        -- measured properly.
        AND sum(c.litres) / sum(c.hours) <= ${MAX_PLAUSIBLE_L_PER_HOUR}
     ORDER BY 2 DESC`

  const derived = rows
    .map(r => ({
      vehicleId: r.vehicle_id,
      runs:      Number(r.runs),
      lPerHour:  r.l_per_hour,
      lPerKm:    r.l_per_km,
    }))
    // A run with no measurable hours produces a null rate rather than a
    // division by zero; there is nothing to store for it.
    .filter(r => r.lPerHour != null && Number.isFinite(r.lPerHour))

  let stored = 0
  if (apply) {
    const derivedAt = new Date()
    for (const r of derived) {
      await prisma.vehicleFuelRate.upsert({
        where:  { vehicleId: r.vehicleId },
        create: { vehicleId: r.vehicleId, lPerHour: r.lPerHour, lPerKm: r.lPerKm, runs: r.runs, windowDays: days, derivedAt },
        update: { lPerHour: r.lPerHour, lPerKm: r.lPerKm, runs: r.runs, windowDays: days, derivedAt },
      })
      stored++
    }
  }

  // Delete stored rates the current rules would no longer produce.
  //
  // Upserting alone is not enough, and the gap bit on 2026-08-14: when
  // MAX_PLAUSIBLE_L_PER_HOUR was introduced, the three impossible rates simply
  // stopped being regenerated — and therefore survived untouched, so
  // `MUFINDI - DG 12` went on serving 109.89 L/h as its OWN rate. A row that
  // vanishes from the derivation's output is indistinguishable, to an upsert,
  // from a machine that was idle all week.
  //
  // Idleness is why rows are kept rather than truncated each run, and that is
  // still right. But no window and no idleness can make an impossible rate
  // correct, so this one class is pruned explicitly.
  let pruned = 0
  if (apply) {
    const { count } = await prisma.vehicleFuelRate.deleteMany({
      where: { lPerHour: { gt: MAX_PLAUSIBLE_L_PER_HOUR } },
    })
    pruned = count
  }

  const usable = derived.filter(r => r.runs >= MIN_RUNS).length
  const out: RateDerivationOutcome = { windowDays: days, derived: derived.length, usable, stored, pruned }
  logger.info(out, 'Fuel consumption rates derived')
  return out
}

/**
 * Rates for every vehicle in one org, already resolved against the org+type
 * fallback — so the caller gets one lookup and never has to know which vehicles
 * had enough runs of their own.
 *
 * The type medians are pooled across the ORG, not the org's own vehicles alone;
 * `resolveRates` groups on organisation + vehicle type, and both orgs' rates
 * are loaded so a group is never thinned by the org filter. `MUFINDI` tractors
 * fall back to MUFINDI tractors.
 */
export async function getOrgFuelRates(orgId: string): Promise<Map<string, ResolvedRate>> {
  const [rates, vehicles] = await Promise.all([
    prisma.vehicleFuelRate.findMany({ select: { vehicleId: true, lPerHour: true, lPerKm: true, runs: true } }),
    prisma.vehicle.findMany({
      select: { id: true, organisationId: true, vehicleType: true },
    }),
  ])

  const groups: RateGroup[] = vehicles.map(v => ({
    vehicleId: v.id, organisationId: v.organisationId, vehicleType: v.vehicleType,
  }))
  const resolved = resolveRates(rates as VehicleRate[], groups)

  // Narrowed to the requested org on the way out, after the medians are formed.
  const mine = new Set(vehicles.filter(v => v.organisationId === orgId).map(v => v.id))
  const out = new Map<string, ResolvedRate>()
  for (const [id, r] of resolved) if (mine.has(id)) out.set(id, r)
  return out
}
