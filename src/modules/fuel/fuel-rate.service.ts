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
         AND NOT EXISTS (SELECT 1 FROM fuel_fillings f
                          WHERE f.vehicle_id = r.vehicle_id AND f.filled_at BETWEEN r.t0 AND r.t1)
         AND NOT EXISTS (SELECT 1 FROM fuel_thefts t
                          WHERE t.vehicle_id = r.vehicle_id AND t.began_at BETWEEN r.t0 AND r.t1)
    )
    SELECT c.vehicle_id, count(*) AS runs,
           round((sum(c.litres) / nullif(sum(c.hours), 0))::numeric, 2)::float8 AS l_per_hour,
           round((sum(c.litres) / nullif(sum(c.km),    0))::numeric, 3)::float8 AS l_per_km
      FROM clean c GROUP BY 1 HAVING sum(c.hours) > 0 ORDER BY 2 DESC`

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

  const usable = derived.filter(r => r.runs >= MIN_RUNS).length
  const out: RateDerivationOutcome = { windowDays: days, derived: derived.length, usable, stored }
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
