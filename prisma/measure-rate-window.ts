/**
 * The three questions behind widening the rate window.
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * `RATE_WINDOW_DAYS = 3` is a t3.micro constraint rather than a modelling
 * choice, and on 2026-08-27 it produced a 53% swing in one saloon's km/L
 * between two derivations two days apart (`MUFINDI: LMV 17`, 15.15 -> 23.26,
 * six runs down to three). That is not a rate; it is a sample. Before widening
 * it, three things have to be known, and only the third is about cost.
 *
 * ## 1. Does an inactive vehicle skew a type median?
 *
 * `getOrgFuelRates` does an unfiltered `findMany` over every vehicle and every
 * rate row on every call. A vehicle decommissioned months ago keeps its stored
 * rate — the derivation deliberately preserves rows for machines that were idle
 * — and therefore keeps voting in its type's median. Whether that matters is a
 * question about how many such rows exist, not a matter of taste.
 *
 * ## 2. Can the engine-hours METER serve as a run's denominator?
 *
 * The rate query divides litres by a run's WALL-CLOCK span. `dayEngineSeconds`
 * establishes that the counter beats gap integration over a DAY — 0 s error
 * against the operator's own figure for `KTCC 959G`, versus 664 s and 1,761 s.
 * It does not follow that it beats wall-clock over a twenty-minute RUN, and the
 * Stage 2 measurement is the reason to doubt it: the counter updates roughly
 * every five minutes while fixes arrive every ~26 s, so on a 20-minute run its
 * resolution is a quarter of the quantity being measured.
 *
 * This compares the two over real runs. Adopt only if they agree closely; a
 * denominator that is coarser than the thing it divides is not an improvement
 * however authoritative its source.
 *
 * ## 3. How far back does the meter actually reach?
 *
 * The Stage 2 backfill ran with a bounded window. A 14-day rate window that
 * reaches past the meter's coverage would silently fall back to wall-clock for
 * the older half, which is worse than using one method throughout.
 *
 * Sampled in narrow windows rather than counted per day: a full scan of 15 days
 * of `vehicle_telemetries` is tens of millions of rows on a box with ~1 GB of
 * RAM, and the question only needs presence, not a census.
 */

import { prisma } from '../src/lib/prisma.js'
import { MIN_RUNS } from '../src/modules/fuel/fuel-rate.js'

const n = (x: bigint | number | null | undefined) => Number(x ?? 0).toLocaleString()
const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%` : '—')
const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)

// ── 1. inactive vehicles holding rates ──────────────────────────────────────

console.log('\n  1. Do decommissioned machines still vote in a type median?\n')

const [skew] = await prisma.$queryRaw<Array<{
  vehicles: bigint; inactive: bigint; rates: bigint; inactive_rates: bigint; voting: bigint
}>>`
  SELECT count(*)                                          AS vehicles,
         count(*) FILTER (WHERE NOT v.is_active)            AS inactive,
         count(r.vehicle_id)                                AS rates,
         count(r.vehicle_id) FILTER (WHERE NOT v.is_active) AS inactive_rates,
         count(r.vehicle_id) FILTER (WHERE NOT v.is_active
                                       AND r.runs >= ${MIN_RUNS}) AS voting
    FROM vehicles v
    LEFT JOIN vehicle_fuel_rates r ON r.vehicle_id = v.id`

console.log(`    vehicles                       ${padL(n(skew?.vehicles), 8)}`)
console.log(`      ...inactive                  ${padL(n(skew?.inactive), 8)}`)
console.log(`    rate rows                      ${padL(n(skew?.rates), 8)}`)
console.log(`      ...held by inactive vehicles ${padL(n(skew?.inactive_rates), 8)}`)
console.log(`      ...clearing MIN_RUNS, so counted in a median` +
            `  ${padL(n(skew?.voting), 5)}`)

// Where those votes land, and what they do to the group they land in.
const groups = await prisma.$queryRaw<Array<{
  org: string; vtype: string; live: bigint; dead: bigint;
  med_all: number; med_live: number | null
}>>`
  WITH pool AS (
    SELECT o.code AS org, upper(coalesce(v.vehicle_type, 'UNSPECIFIED')) AS vtype,
           v.is_active, r.l_per_hour
      FROM vehicle_fuel_rates r
      JOIN vehicles v      ON v.id = r.vehicle_id
      JOIN organisations o ON o.id = v.organisation_id
     WHERE r.runs >= ${MIN_RUNS}
  )
  SELECT org, vtype,
         count(*) FILTER (WHERE is_active)     AS live,
         count(*) FILTER (WHERE NOT is_active) AS dead,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY l_per_hour)::float8 AS med_all,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY l_per_hour)
           FILTER (WHERE is_active)::float8    AS med_live
    FROM pool
   GROUP BY 1, 2
  HAVING count(*) FILTER (WHERE NOT is_active) > 0
   ORDER BY 3 DESC`

if (groups.length === 0) {
  console.log('\n    No group contains an inactive contributor — the skew does not exist today.')
} else {
  console.log('\n    groups an inactive rate contributes to')
  console.log('      org + type                  live  dead   median now   live only    shift')
  for (const g of groups) {
    const shift = g.med_live == null ? '—'
      : `${(((g.med_all - g.med_live) / g.med_live) * 100).toFixed(1)}%`
    console.log(`      ${padR(`${g.org} ${g.vtype}`, 26)}${padL(n(g.live), 5)}${padL(n(g.dead), 6)}` +
                `${padL(g.med_all.toFixed(2), 13)}${padL(g.med_live?.toFixed(2) ?? '—', 12)}${padL(shift, 9)}`)
  }
}

// ── 2. meter vs wall-clock, over real runs ──────────────────────────────────
//
// Run segmentation copied from `deriveFuelRates` so the comparison is against
// the denominator actually in use, not an approximation of it.

console.log('\n\n  2. Would the engine-hours counter be a better run denominator?\n')

const runs = await prisma.$queryRaw<Array<{
  n: bigint; both: bigint; p10: number; p50: number; p90: number;
  within5: bigint; within15: bigint; meter_zero: bigint
}>>`
  WITH s AS (
    SELECT x.vehicle_id, x.captured_at, x.engine_on, x.engine_hours_meter,
           lag(x.captured_at) OVER w AS prev_at,
           lag(x.engine_on)   OVER w AS prev_on
      FROM vehicle_telemetries x
     WHERE x.captured_at >= now() - make_interval(days => 3)
       AND x.fuel_level_ml IS NOT NULL
    WINDOW w AS (PARTITION BY x.vehicle_id ORDER BY x.captured_at)
  ), b AS (
    SELECT *, sum(CASE WHEN prev_on IS DISTINCT FROM engine_on OR prev_at IS NULL
                         OR extract(epoch FROM (captured_at - prev_at)) > 900
                       THEN 1 ELSE 0 END)
                OVER (PARTITION BY vehicle_id ORDER BY captured_at) AS grp
      FROM s
  ), r AS (
    SELECT vehicle_id, grp, bool_and(engine_on) AS eng, count(*) AS cnt,
           extract(epoch FROM (max(captured_at) - min(captured_at))) / 3600.0 AS wall_h,
           (max(engine_hours_meter) - min(engine_hours_meter))                AS meter_h
      FROM b GROUP BY 1, 2
  ), q AS (
    SELECT wall_h, meter_h, (meter_h - wall_h) / nullif(wall_h, 0) AS rel
      FROM r WHERE eng AND cnt >= 10 AND wall_h >= 0.33
  )
  SELECT count(*)                                    AS n,
         count(*) FILTER (WHERE meter_h IS NOT NULL)  AS both,
         percentile_cont(0.10) WITHIN GROUP (ORDER BY rel)::float8 AS p10,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY rel)::float8 AS p50,
         percentile_cont(0.90) WITHIN GROUP (ORDER BY rel)::float8 AS p90,
         count(*) FILTER (WHERE abs(rel) <= 0.05)     AS within5,
         count(*) FILTER (WHERE abs(rel) <= 0.15)     AS within15,
         count(*) FILTER (WHERE meter_h = 0)          AS meter_zero
    FROM q`

const rn = Number(runs[0]?.n ?? 0), rboth = Number(runs[0]?.both ?? 0)
console.log(`    qualifying runs in a 3-day window        ${padL(n(rn), 8)}`)
console.log(`      ...carrying a meter reading            ${padL(n(rboth), 8)}  ${pc(rboth, rn)}`)
if (rboth > 0) {
  console.log(`\n    (meter hours - wall hours) / wall hours`)
  console.log(`      p10 ${padL((runs[0]!.p10 * 100).toFixed(1), 8)}%` +
              `   p50 ${padL((runs[0]!.p50 * 100).toFixed(1), 8)}%` +
              `   p90 ${padL((runs[0]!.p90 * 100).toFixed(1), 8)}%`)
  console.log(`      within  5% of wall clock  ${padL(n(runs[0]!.within5), 7)}  ${pc(Number(runs[0]!.within5), rboth)}`)
  console.log(`      within 15% of wall clock  ${padL(n(runs[0]!.within15), 7)}  ${pc(Number(runs[0]!.within15), rboth)}`)
  console.log(`      meter did not move at all ${padL(n(runs[0]!.meter_zero), 7)}  ${pc(Number(runs[0]!.meter_zero), rboth)}` +
              `   <- runs the counter would price at INFINITY L/h`)
}

// ── 3. how far back the meter reaches ───────────────────────────────────────
//
// Ten-minute probes rather than a per-day census: presence is the question.

console.log('\n\n  3. How far back is the meter populated?\n')
console.log('    days ago    sampled rows   with meter')
for (const back of [1, 3, 5, 7, 10, 14, 21, 30]) {
  const [s] = await prisma.$queryRaw<Array<{ rows: bigint; meter: bigint }>>`
    SELECT count(*) AS rows,
           count(*) FILTER (WHERE engine_hours_meter IS NOT NULL) AS meter
      FROM vehicle_telemetries
     WHERE captured_at >= now() - make_interval(days => ${back}::int)
       AND captured_at <  now() - make_interval(days => ${back}::int) + interval '10 minutes'`
  const rows = Number(s?.rows ?? 0), meter = Number(s?.meter ?? 0)
  console.log(`    ${padL(String(back), 5)}    ${padL(n(rows), 12)}   ${padL(n(meter), 10)}  ${pc(meter, rows)}`)
}
console.log()

process.exit(0)
