/**
 * Can the engine-hours meter stand in for an ignition line?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The question
 *
 * `engine_on` is `ignition ?? (speed_kmh > 0)`, so on a unit whose ignition line
 * reports nothing it merely restates whether the vehicle MOVED — and a digging
 * excavator at 0 km/h is indistinguishable from a parked one. That single gap is
 * what caps `SIPHON`: measured 2026-08-25, only 6 of 754 drains were provably
 * parked.
 *
 * The meter is the candidate fix. It is present on 96.6% of fixes, and a
 * cumulative counter that ADVANCES between two fixes is a measurement that the
 * engine ran in between — not a heuristic. But "the engine ran during the
 * interval" and "the ignition was on at the fix" are not the same proposition,
 * and the difference has to be measured rather than assumed.
 *
 * ## The method
 *
 * Rows where `ignition_source = 'SENSOR'` carry a genuine binary line, so their
 * `engine_on` is ground truth. For each, take the meter delta against that
 * vehicle's previous fix and ask whether the two agree. That is a real external
 * check — the same shape as the one that inverted the step-fraction hypothesis —
 * and it is only affordable because the backfill put both columns on the
 * telemetry row, so this reads 4 GB rather than joining 8.6 GB of JSON.
 *
 * ## Reading the result
 *
 * Agreement is not expected to be perfect and perfection would be suspicious.
 * The meter describes an INTERVAL and the sensor describes an INSTANT, so a
 * machine that ran and then switched off just before its fix legitimately shows
 * meter-ran with ignition-off. Disagreement should therefore concentrate at
 * transitions and at long gaps, and the tables below break it out that way so a
 * high headline number cannot hide a systematic skew.
 *
 * What decides adoption is the bottom section: how many fixes that currently
 * have NO ignition state would gain one. If that is small the change is not
 * worth its risk however well it agrees.
 */

import { prisma } from '../src/lib/prisma.js'

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt
}
/** One day by default: the window function partitions and sorts, on a small box. */
const DAYS = Number(arg('days', '1'))
const cutoff = new Date(Date.now() - DAYS * 86_400_000)

const n = (x: bigint | number | undefined) => Number(x ?? 0).toLocaleString()
const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%` : '—')
const padL = (s: string, w: number) => s.padStart(w)
const padR = (s: string, w: number) => s.padEnd(w)

console.log(`\n  Meter-vs-sensor agreement, last ${DAYS} day(s)\n`)

// ── 1. the confusion matrix on rows where a real sensor answered ────────────
//
// `ran` is the meter advancing by more than a hair. The floor is deliberately
// tiny rather than zero: the counter is a float and a stationary machine can
// jitter in the last decimal without having run.

const matrix = await prisma.$queryRaw<Array<{
  sensor_on: boolean; meter_ran: boolean; n: bigint; gap_p50: number
}>>`
  WITH seq AS (
    SELECT vehicle_id, captured_at, engine_on, engine_hours_meter,
           lag(engine_hours_meter) OVER w AS prev_meter,
           EXTRACT(EPOCH FROM captured_at - lag(captured_at) OVER w) AS gap_s
      FROM vehicle_telemetries
     WHERE captured_at >= ${cutoff}
       AND ignition_source = 'SENSOR'
       AND engine_hours_meter IS NOT NULL
    WINDOW w AS (PARTITION BY vehicle_id ORDER BY captured_at)
  )
  SELECT engine_on                              AS sensor_on,
         (engine_hours_meter - prev_meter) > 0.0005 AS meter_ran,
         count(*)                               AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_s) AS gap_p50
    FROM seq
   WHERE prev_meter IS NOT NULL AND gap_s > 0 AND gap_s <= 900
     AND (engine_hours_meter - prev_meter) >= 0
   GROUP BY 1, 2
   ORDER BY 1, 2
`

let agree = 0, total = 0
console.log('    sensor says   meter says          rows    median gap')
for (const r of matrix) {
  const rows = Number(r.n)
  total += rows
  if (r.sensor_on === r.meter_ran) agree += rows
  console.log(`    ${padR(r.sensor_on ? 'ON' : 'OFF', 13)} ${padR(r.meter_ran ? 'RAN' : 'did not', 12)}` +
              `${padL(n(rows), 10)}    ${padL(`${Math.round(r.gap_p50 ?? 0)} s`, 8)}` +
              `${r.sensor_on === r.meter_ran ? '   agree' : '   DISAGREE'}`)
}
console.log(`\n    agreement: ${pc(agree, total)} of ${n(total)} comparable fixes`)

// ── 2. does disagreement concentrate at long gaps? ──────────────────────────
//
// If it does, the meter is fine and the INTERVAL is the problem — which argues
// for a gap ceiling on the rule rather than against the rule.

const byGap = await prisma.$queryRaw<Array<{ band: string; n: bigint; agreed: bigint }>>`
  WITH seq AS (
    SELECT engine_on, engine_hours_meter,
           lag(engine_hours_meter) OVER w AS prev_meter,
           EXTRACT(EPOCH FROM captured_at - lag(captured_at) OVER w) AS gap_s
      FROM vehicle_telemetries
     WHERE captured_at >= ${cutoff}
       AND ignition_source = 'SENSOR'
       AND engine_hours_meter IS NOT NULL
    WINDOW w AS (PARTITION BY vehicle_id ORDER BY captured_at)
  )
  SELECT CASE WHEN gap_s <=  45 THEN 'a. <= 45 s'
              WHEN gap_s <= 120 THEN 'b. 45-120 s'
              WHEN gap_s <= 400 THEN 'c. 2-7 min'
              ELSE                   'd. 7-15 min' END AS band,
         count(*) AS n,
         count(*) FILTER (
           WHERE engine_on = ((engine_hours_meter - prev_meter) > 0.0005)
         ) AS agreed
    FROM seq
   WHERE prev_meter IS NOT NULL AND gap_s > 0 AND gap_s <= 900
     AND (engine_hours_meter - prev_meter) >= 0
   GROUP BY 1 ORDER BY 1
`
console.log('\n    by gap between fixes')
for (const r of byGap) {
  console.log(`      ${padR(r.band, 14)}${padL(n(r.n), 10)}   agreement ${pc(Number(r.agreed), Number(r.n))}`)
}

// ── 3. the prize: fixes that would GAIN a state ─────────────────────────────

const [gain] = await prisma.$queryRaw<Array<{
  none_rows: bigint; with_meter: bigint; with_prev: bigint
}>>`
  WITH seq AS (
    SELECT ignition_source, engine_hours_meter,
           lag(engine_hours_meter) OVER w AS prev_meter,
           EXTRACT(EPOCH FROM captured_at - lag(captured_at) OVER w) AS gap_s
      FROM vehicle_telemetries
     WHERE captured_at >= ${cutoff}
    WINDOW w AS (PARTITION BY vehicle_id ORDER BY captured_at)
  )
  SELECT count(*) FILTER (WHERE ignition_source = 'NONE') AS none_rows,
         count(*) FILTER (WHERE ignition_source = 'NONE'
                            AND engine_hours_meter IS NOT NULL) AS with_meter,
         count(*) FILTER (WHERE ignition_source = 'NONE'
                            AND engine_hours_meter IS NOT NULL
                            AND prev_meter IS NOT NULL
                            AND gap_s > 0 AND gap_s <= 900) AS with_prev
    FROM seq
`
const none = Number(gain?.none_rows ?? 0)
console.log(`\n    fixes with NO ignition today          ${padL(n(none), 11)}`)
console.log(`      ...carrying a meter reading         ${padL(n(gain?.with_meter), 11)}  ${pc(Number(gain?.with_meter ?? 0), none)}`)
console.log(`      ...AND a usable previous fix        ${padL(n(gain?.with_prev), 11)}  ${pc(Number(gain?.with_prev ?? 0), none)}`)
console.log(`\n    That last figure is the coverage this rule would actually buy.\n`)

// ── 4. the same question asked per WINDOW instead of per fix ────────────────
//
// Section 1 compares adjacent fixes and section 3 counts what that would cover,
// but section 2's gap curve says the per-fix framing is wrong: agreement climbs
// with the gap because the METER UPDATES EVERY ~5 MINUTES while fixes arrive
// every ~26 s. Measured on rows the sensor says are running, the delta is 0 on
// 9,818 of them and then jumps by ~300 s; the smallest step the counter can
// take is 1 s, so this is cadence, not resolution.
//
// So ask the question the consumer actually asks. `DropEvidence.engineSeconds`
// is engine time across a FALL, and SIPHON's parked test is "did this machine
// run at all during it" — both window quantities, both long enough to contain
// meter ticks.
//
// The two directions are reported separately and they are NOT equally strong,
// which is the whole finding.

for (const mins of [10, 15, 30]) {
  const win = await prisma.$queryRaw<Array<{ meter_ran: boolean; sensor_ran: boolean; n: bigint }>>`
    WITH bucketed AS (
      SELECT vehicle_id,
             floor(EXTRACT(EPOCH FROM captured_at) / (${mins} * 60)) AS bucket,
             engine_on, engine_hours_meter
        FROM vehicle_telemetries
       WHERE captured_at >= ${cutoff}
         AND ignition_source = 'SENSOR' AND engine_hours_meter IS NOT NULL
    ), agg AS (
      SELECT max(engine_hours_meter) - min(engine_hours_meter) AS meter_delta,
             bool_or(engine_on) AS sensor_ran
        FROM bucketed GROUP BY vehicle_id, bucket HAVING count(*) >= 5
    )
    SELECT (meter_delta > 0.0005) AS meter_ran, sensor_ran, count(*) AS n
      FROM agg GROUP BY 1, 2
  `
  let ok = 0, all = 0, quietAll = 0, quietOk = 0
  for (const r of win) {
    const c = Number(r.n); all += c
    if (r.meter_ran === r.sensor_ran) ok += c
    if (!r.meter_ran) { quietAll += c; if (!r.sensor_ran) quietOk += c }
  }
  console.log(`    ${padR(`${mins}-min windows`, 16)} n=${padL(n(all), 7)}   ` +
              `overall ${padL(pc(ok, all), 7)}   ` +
              `"never ran" correct ${padL(pc(quietOk, quietAll), 7)}`)
}
console.log(`\n    The second column is what a burn RATE needs; the third is what a THEFT`)
console.log(`    verdict needs, and they are not the same number.\n`)

process.exit(0)
