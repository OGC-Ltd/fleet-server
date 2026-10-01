/**
 * Derive and store each vehicle's fuel rate, in the denominator that suits it.
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
 * ## The run's denominator is wall clock, and the counter does not beat it
 *
 * A run's hours are the span between its first and last reading. `fuel-tank-
 * state`'s `dayEngineSeconds` shows the engine-hours COUNTER beating gap
 * integration over a whole day — 0 s error against the operator's own figure
 * for `KTCC 959G`, against 664 s and 1,761 s — so the counter is the obvious
 * candidate here too. Measured over real runs on 2026-08-27, it is not:
 *
 * - it reaches only **58.2%** of qualifying runs
 * - the median run reads **4.6% SHORT** against wall clock, p10 −19.6%
 * - only **45%** of runs agree within 5%
 * - on **1.8%** the counter does not move at all, which would price the run at
 *   infinite litres per hour
 *
 * The cause is cadence, not accuracy: the counter ticks about every five
 * minutes while fixes arrive every ~26 s, so across a twenty-minute run its
 * resolution is a quarter of the quantity being divided. It is an excellent
 * measurement of a day and a poor one of a run, and the difference is the
 * length of the window rather than anything about the sensor. See
 * `prisma/measure-rate-window.ts`.
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
import {
  MIN_RUNS, resolveRates, expectedRate,
  type RateGroup, type ResolvedRate, type VehicleRate, type ExpectedRate,
} from './fuel-rate.js'
import { resolveBasis, derivationCapLph } from './fuel-theft-classifier.js'

/**
 * Days of telemetry the derivation reads.
 *
 * SEVEN since 2026-08-27. It was three, on the belief that three was the only
 * window this instance could survive — "a t3.micro that is already swapping
 * beside a 1 GB RDS". Timed against production, that belief was wrong about
 * both the limit and its cause:
 *
 * | window | wall clock | vehicles rated | clearing MIN_RUNS |
 * | --- | --- | --- | --- |
 * | 3 | 21.5 s | 190 | 154 |
 * | **7** | **31.0 s** | **214** | **198** |
 * | 14 | 53.5 s | 241 | 225 |
 * | 21 | 57.1 s | 255 | 235 |
 * | 30 | — | timeout | — |
 *
 * Nothing swapped and nothing failed on memory. What 30 days hits is
 * `query_timeout: 60_000` in lib/prisma — a deliberate client-side guard shared
 * with the API and SSE paths, there to reject queries on connections the pooler
 * dropped. So the ceiling is a timeout the application chose, not a machine
 * that cannot do the work, and the fix for a wider window is to give this batch
 * job its own budget rather than to raise a guard the request path needs.
 *
 * Seven rather than fourteen or twenty-one, which both ran: 14 leaves 11% of
 * headroom under that 60 s guard and 21 leaves 5%, measured over an SSH tunnel
 * on an otherwise quiet afternoon. A weekly job that trips the timeout does not
 * fail loudly — it simply stops refreshing rates — and 7 takes the larger half
 * of the available gain (154 → 198 usable, +29%) for half the risk.
 *
 * Why it matters more than it used to: on 2026-08-27 `MUFINDI: LMV 17` moved
 * 15.15 → 23.26 km/L between two derivations two days apart, six runs down to
 * three. At three days a rate is a sample of one working week's Tuesday. Since
 * `primary_basis` now names these figures as a machine's real rate, and 3.6
 * will feed them to `resolveBand`, a baseline that swings 53% cannot carry a
 * verdict.
 *
 * `--days` remains for deliberate wider runs; 14 and 21 are both measured to
 * work with someone watching.
 */
export const RATE_WINDOW_DAYS = 7

/** Longest gap that can sit inside one run, in seconds. Beyond it the run cuts. */
const MAX_RUN_GAP_SECONDS = 900

/**
 * The half-metre grid the dig detector uses, in degrees.
 *
 * Kept in step with `SNAP_DEGREES` in analytics/vehicle-daily-stats: "the
 * machine has not moved" has to mean the same thing in both places, or an
 * excavator would be idle to one and digging to the other on the same minute.
 */
const SNAP_DEGREES = 0.000005

/** Below this a machine counts as stationary, matching the dig detector. */
const STILL_KMH = 1

/**
 * How one-sided a run must be to describe idling, or working.
 *
 * Runs are classified by their DOMINANT state rather than segmented at every
 * transition. Segmenting fragments a working day into hundreds of pieces far
 * too short to carry a fuel measurement — the derivation needs 20 minutes and
 * ten readings — while a run that is 80% one thing is fairly described by it.
 *
 * A run between the two thresholds is MIXED and contributes to neither figure.
 * That is the point: it is not evidence about idling or about working, and
 * admitting it to both would re-blend precisely what this separates.
 */
const IDLE_RUN_SHARE = 0.8
const WORK_RUN_SHARE = 0.2

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
  /**
   * Stored rows deleted for exceeding MAX_PLAUSIBLE_L_PER_HOUR — see below.
   * On a dry run this is what WOULD be deleted, not zero.
   */
  pruned:     number
  /**
   * Of the derived rates, how many belong to a machine judged per kilometre.
   *
   * Reported because it is the one number that says whether the basis split is
   * reaching anything: measured 2026-08-27, 55 of 207 DISTANCE machines have a
   * rate of their own, so a fall in this figure means road vehicles are quietly
   * losing their denominator rather than the fleet having changed shape.
   */
  distanceBasis: number
  /**
   * Of the derived rates, how many earned a SEPARATE idle or working figure —
   * MIN_RUNS of that kind, not merely one run.
   *
   * Reported because the split's whole value is that the two differ (1.85x
   * overall, 7.22x on TRACTOR_MEDIUM), and a figure nothing has is worth
   * nothing. A collapse here means runs stopped being one-sided enough to
   * classify, which is a telemetry change rather than a fleet one.
   */
  withIdleRate: number
  withWorkRate: number
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
  // Machine identity FIRST, because the plausibility cap is now per class and
  // the query needs it. Both the basis and the cap come off the same load, so
  // this is one extra query for the whole fleet rather than one per vehicle.
  const orgs   = await prisma.organisation.findMany({ select: { id: true, code: true } })
  const codeOf = new Map(orgs.map(o => [o.id, o.code]))
  const fleet  = await prisma.vehicle.findMany({
    select: {
      id: true, registrationPlate: true, vehicleType: true,
      tankCapacityLitres: true, organisationId: true,
    },
  })

  const basisOf = new Map<string, 'HOURS' | 'DISTANCE'>()
  const capIds: string[] = []
  const capLph: number[] = []
  for (const v of fleet) {
    const code = codeOf.get(v.organisationId) ?? ''
    const m = {
      plate: v.registrationPlate,
      vehicleType: v.vehicleType,
      tankCapacityLitres: v.tankCapacityLitres,
    }
    basisOf.set(v.id, resolveBasis(code, m))
    capIds.push(v.id)
    capLph.push(derivationCapLph(code, m, MAX_PLAUSIBLE_L_PER_HOUR))
  }

  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; runs: bigint; l_per_hour: number; l_per_km: number | null
    idle_l_per_hour: number | null; work_l_per_hour: number | null
    idle_runs: bigint; work_runs: bigint
  }>>`
    WITH caps AS (
      -- One plausibility ceiling per vehicle, from its class band. Bound as
      -- arrays rather than interpolated: this is the only place the derivation
      -- takes a per-vehicle value, and a VALUES list built by string
      -- concatenation is the shape that has to be audited every time it is read.
      SELECT * FROM unnest(${capIds}::text[], ${capLph}::double precision[])
        AS t(vehicle_id, max_lph)
    ), s AS (
      SELECT x.vehicle_id, x.captured_at, x.fuel_level_ml, x.engine_on,
             COALESCE(x.speed_kmh, 0) AS spd,
             -- Has the machine moved a half-metre grid cell? The dig detector's
             -- own grid (vehicle-daily-stats' SNAP_DEGREES), so "stationary but
             -- working" means the same thing in both places rather than being
             -- decided twice. Expressed arithmetically rather than through
             -- ST_SnapToGrid: identical rule, no geometry constructed per fix,
             -- and this runs over the whole fuel-carrying window.
             floor(x.lat / ${SNAP_DEGREES})                 AS cell_y,
             floor(x.lng / ${SNAP_DEGREES})                 AS cell_x,
             lag(floor(x.lat / ${SNAP_DEGREES})) OVER w     AS prev_cell_y,
             lag(floor(x.lng / ${SNAP_DEGREES})) OVER w     AS prev_cell_x,
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
             (array_agg(fuel_level_ml ORDER BY captured_at DESC))[1] AS l1,
             -- Seconds the machine ran while stationary AND in the same grid
             -- cell as the previous fix: running, and doing nothing observable.
             sum(CASE WHEN dt BETWEEN 1 AND ${MAX_RUN_GAP_SECONDS}
                       AND spd < ${STILL_KMH}
                       AND prev_cell_y IS NOT NULL
                       AND cell_y = prev_cell_y AND cell_x = prev_cell_x
                      THEN dt ELSE 0 END) AS idle_s,
             sum(CASE WHEN dt BETWEEN 1 AND ${MAX_RUN_GAP_SECONDS} THEN dt ELSE 0 END) AS total_s
        FROM b GROUP BY 1, 2
    ), clean AS (
      SELECT r.*, (r.l0 - r.l1) / 1000.0 AS litres,
             r.idle_s / nullif(r.total_s, 0) AS idle_share
        FROM runs r
       LEFT JOIN caps ON caps.vehicle_id = r.vehicle_id
       WHERE r.eng AND r.n >= 10 AND r.hours >= 0.33
         AND r.l0 > r.l1 AND (r.l0 - r.l1) BETWEEN 300 AND 200000
         -- Bound the implied RATE, not only the drop. r.hours >= 0.33 above
         -- makes the division safe. See MAX_PLAUSIBLE_L_PER_HOUR: a 20-minute
         -- run falling 100 L implies 300 L/h and cleared every other filter.
         --
         -- Per class since 2026-08-27 — see derivationCapLph. COALESCE to the
         -- flat floor so a vehicle missing from the caps CTE is bounded exactly
         -- as before rather than escaping the test altogether.
         AND ((r.l0 - r.l1) / 1000.0) / r.hours
               <= COALESCE(caps.max_lph, ${MAX_PLAUSIBLE_L_PER_HOUR})
         AND NOT EXISTS (SELECT 1 FROM fuel_fillings f
                          WHERE f.vehicle_id = r.vehicle_id AND f.filled_at BETWEEN r.t0 AND r.t1)
         AND NOT EXISTS (SELECT 1 FROM fuel_thefts t
                          WHERE t.vehicle_id = r.vehicle_id AND t.began_at BETWEEN r.t0 AND r.t1)
    )
    SELECT c.vehicle_id, count(*) AS runs,
           round((sum(c.litres) / nullif(sum(c.hours), 0))::numeric, 2)::float8 AS l_per_hour,
           round((sum(c.litres) / nullif(sum(c.km),    0))::numeric, 3)::float8 AS l_per_km,
           -- The same ratio, over the runs that were overwhelmingly one thing.
           -- A run between the two thresholds is MIXED and contributes to
           -- neither: it is not evidence about idling or about working, and
           -- letting it into both would blend exactly what this separates.
           round((sum(c.litres) FILTER (WHERE c.idle_share >= ${IDLE_RUN_SHARE})
                  / nullif(sum(c.hours) FILTER (WHERE c.idle_share >= ${IDLE_RUN_SHARE}), 0))::numeric, 2)::float8
             AS idle_l_per_hour,
           round((sum(c.litres) FILTER (WHERE c.idle_share <= ${WORK_RUN_SHARE})
                  / nullif(sum(c.hours) FILTER (WHERE c.idle_share <= ${WORK_RUN_SHARE}), 0))::numeric, 2)::float8
             AS work_l_per_hour,
           count(*) FILTER (WHERE c.idle_share >= ${IDLE_RUN_SHARE}) AS idle_runs,
           count(*) FILTER (WHERE c.idle_share <= ${WORK_RUN_SHARE}) AS work_runs
      FROM clean c
      LEFT JOIN caps ON caps.vehicle_id = c.vehicle_id
     GROUP BY 1, caps.max_lph
     HAVING sum(c.hours) > 0
        -- Backstop: a vehicle whose every run is individually plausible can
        -- still aggregate to something that is not. Excluding it here is
        -- deliberate — no rate at all beats a wrong one, because the fallback
        -- below it (its type's median) is built from machines that were
        -- measured properly.
        AND sum(c.litres) / sum(c.hours)
              <= COALESCE(caps.max_lph, ${MAX_PLAUSIBLE_L_PER_HOUR})
     ORDER BY 2 DESC`

  const derived = rows
    .map(r => ({
      vehicleId: r.vehicle_id,
      runs:      Number(r.runs),
      lPerHour:  r.l_per_hour,
      lPerKm:    r.l_per_km,
      // Absent below MIN_RUNS rather than thin-and-present. The same bar the
      // blended rate clears, for the same reason: a rate off one or two runs is
      // one shift's load and one probe's afternoon, and here it would be handed
      // to a judgement as "what this machine burns doing nothing".
      idleLPerHour: Number(r.idle_runs) >= MIN_RUNS ? r.idle_l_per_hour : null,
      workLPerHour: Number(r.work_runs) >= MIN_RUNS ? r.work_l_per_hour : null,
      idleRuns:     Number(r.idle_runs),
      workRuns:     Number(r.work_runs),
    }))
    // A run with no measurable hours produces a null rate rather than a
    // division by zero; there is nothing to store for it.
    .filter(r => r.lPerHour != null && Number.isFinite(r.lPerHour))

  // `basisOf` was resolved above, alongside the caps — the query needs the class
  // anyway, so one fleet load answers both questions. Which denominator a rate
  // is in has to be recorded rather than inferred at read time: the query
  // computes both figures for every machine indiscriminately, and without this
  // the table cannot distinguish a truck's 0.4 l_per_km — its real rate — from
  // an excavator's 7.361, which is the arithmetic of a machine that does not
  // travel.

  let stored = 0
  if (apply) {
    const derivedAt = new Date()
    for (const r of derived) {
      // Absent rather than guessed: a vehicle the lookup missed keeps a null
      // basis, which reads as "not yet resolved". Writing HOURS for it would be
      // the same over-generalisation this column exists to record the end of.
      const primaryBasis = basisOf.get(r.vehicleId) ?? null
      const fields = {
        lPerHour: r.lPerHour, lPerKm: r.lPerKm, primaryBasis,
        idleLPerHour: r.idleLPerHour, workLPerHour: r.workLPerHour,
        idleRuns: r.idleRuns, workRuns: r.workRuns,
        runs: r.runs, windowDays: days, derivedAt,
      }
      await prisma.vehicleFuelRate.upsert({
        where:  { vehicleId: r.vehicleId },
        create: { vehicleId: r.vehicleId, ...fields },
        update: fields,
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
  // Counted on a dry run, deleted on a real one. Reporting 0 either way made
  // the dry run silent about the one destructive thing this function does,
  // which is precisely what a caller runs it to find out.
  // Per class since 2026-08-27. A flat `lPerHour > 40` here was the third and
  // most absolute of the three enforcements: even if a heavy machine's rate had
  // survived the two above, this deleted it on the next run, so no rate over 40
  // could persist under any circumstances. Comparing each stored row against its
  // OWN class cap is what makes the loosening above actually reach the table.
  const capFor = (vehicleId: string) => {
    const i = capIds.indexOf(vehicleId)
    return i >= 0 ? capLph[i]! : MAX_PLAUSIBLE_L_PER_HOUR
  }
  const stale = (await prisma.vehicleFuelRate.findMany({
    where:  { lPerHour: { gt: MAX_PLAUSIBLE_L_PER_HOUR } },
    select: { vehicleId: true, lPerHour: true },
  })).filter(r => r.lPerHour > capFor(r.vehicleId))

  let pruned = stale.length
  if (apply && stale.length > 0) {
    pruned = (await prisma.vehicleFuelRate.deleteMany({
      where: { vehicleId: { in: stale.map(r => r.vehicleId) } },
    })).count
  }

  const usable = derived.filter(r => r.runs >= MIN_RUNS).length
  const distanceBasis = derived.filter(r => basisOf.get(r.vehicleId) === 'DISTANCE').length
  const withIdleRate  = derived.filter(r => r.idleLPerHour != null).length
  const withWorkRate  = derived.filter(r => r.workLPerHour != null).length
  const out: RateDerivationOutcome = {
    windowDays: days, derived: derived.length, usable, stored, pruned,
    distanceBasis, withIdleRate, withWorkRate,
  }
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
/**
 * The rates the tank ledger sets each day against: the register's standard
 * rate where RaiFactorySuite lists the unit (KASULU), the derived one
 * otherwise. See `expectedRate`. Alerts keep `getOrgFuelRates`' derived rates.
 */
export async function getOrgExpectedRates(orgId: string): Promise<Map<string, ExpectedRate>> {
  const [derived, registered] = await Promise.all([
    getOrgFuelRates(orgId),
    prisma.vehicle.findMany({
      where:  { organisationId: orgId, isActive: true, ratedConsumption: { not: null } },
      select: { id: true, ratedConsumption: true, ratedConsumptionBasis: true },
    }),
  ])
  const byId = new Map(registered.map(v => [v.id, v]))
  const out = new Map<string, ExpectedRate>()
  for (const id of new Set([...derived.keys(), ...byId.keys()])) {
    const r = expectedRate(byId.get(id) ?? null, derived.get(id) ?? null)
    if (r) out.set(id, r)
  }
  return out
}

export async function getOrgFuelRates(orgId: string): Promise<Map<string, ResolvedRate>> {
  const [rates, vehicles] = await Promise.all([
    prisma.vehicleFuelRate.findMany({ select: { vehicleId: true, lPerHour: true, lPerKm: true, runs: true } }),
    // Active vehicles only.
    //
    // The derivation deliberately KEEPS a rate row for a machine that produced
    // no runs this window, so a decommissioned vehicle carries its last measured
    // rate indefinitely — and without this filter it goes on voting in its
    // type's median forever, describing a fleet that no longer includes it.
    //
    // Measured 2026-08-27, the skew is currently nil: 7 of 822 vehicles are
    // inactive and none of them holds a rate row. This is therefore a guard on
    // a latent fault rather than a fix for a live one, and it is worth having
    // for the same reason MAX_PLAUSIBLE_L_PER_HOUR's prune is — the day a rated
    // machine is retired, nothing else would notice.
    prisma.vehicle.findMany({
      where:  { isActive: true },
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
