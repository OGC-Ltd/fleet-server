/**
 * Does the STEEPEST INTERVAL of a fall separate a pump from a probe?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## Why this quantity
 *
 * `SIPHON_MAX_STEP_FRACTION` was retired on 2026-09-24 because the share of a
 * fall landing in one interval discards the LENGTH of that interval, and these
 * probes report on change at a 30 s median gap. The retirement note names the
 * replacement: the litres-per-hour implied by the largest single step, judged
 * the way gate 3 already judges the whole-fall average.
 *
 * The two cases that motivated it:
 *
 *   MUFINDI: MTR 09   14.18 L across   6 s  →  8,500 L/h   not fuel flow
 *   MUFINDI: CTR 19   14.95 L across 118 s  →    456 L/h   an ordinary pump
 *
 * Identical step fractions, opposite causes, and only the rate tells them apart.
 *
 * ## What has to be true for this to be worth shipping
 *
 * Gate 3's ceiling is 300 L/h — five litres a minute, slower than any pump — so
 * raising it is the point of the exercise. But raising it alone would let a
 * probe that drops out in one reading report a SIPHON, because the step test
 * that used to absorb those is gone. So the pair only works if the peak-interval
 * rate actually separates the populations. This measures whether it does.
 *
 *   npx tsx prisma/measure-step-rate.ts --org=KASULU --days=14 --tunnel
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG    = arg('org') ?? 'KASULU'
const DAYS   = Number(arg('days') ?? 14)
const TUNNEL = process.argv.includes('--tunnel')
const MIN_GAP = Number(arg('mingap') ?? 1)

function connectionString(): string {
  const u = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!)
  if (TUNNEL) { u.hostname = 'localhost'; u.port = '15432' }
  return u.toString()
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
const n0 = (v: unknown): string => v == null ? '—' : Math.round(Number(v)).toLocaleString()

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

  // The steepest consecutive-reading drop inside each fall, as L/h. Pairs more
  // than five minutes apart are skipped: a long gap is missing data, and
  // dividing a real drop by a reporting outage invents a slow rate.
  const { rows } = await c.query(
    `WITH parked AS (
       SELECT t.vehicle_id,
              date_trunc('hour', t.captured_at)
                + interval '30 min' * floor(extract(minute from t.captured_at)/30) AS win,
              t.fuel_level_ml
         FROM vehicle_telemetries t
        WHERE t.captured_at >= now() - interval '${DAYS} days'
          AND t.fuel_level_ml IS NOT NULL
          AND coalesce(t.speed_kmh,0) = 0 AND t.engine_on = false
     ), spans AS (
       SELECT vehicle_id, win, max(fuel_level_ml) - min(fuel_level_ml) AS swing
         FROM parked GROUP BY vehicle_id, win HAVING count(*) >= 3
     ), prof AS (
       SELECT vehicle_id, count(*) AS windows,
              count(*) FILTER (WHERE swing >= 25000) AS swinging
         FROM spans GROUP BY vehicle_id
     )
     SELECT v.name AS vehicle,
            to_char(t.detected_at + interval '3 hours', 'DD Mon HH24:MI') AS detected,
            t.stolen_ml, t.fall_seconds, t.measured_drop_ml, t.step_fraction,
            t.verdict, t.verdict_reason, t.drain_cause,
            (coalesce(prof.swinging,0) >= 3
              AND coalesce(prof.swinging,0)::float / greatest(coalesce(prof.windows,1),1) >= 0.05)
              AS distrusted,
            s.peak_lph, s.peak_drop_ml, s.peak_gap_s
       FROM fuel_thefts t
       JOIN vehicles v      ON v.id = t.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN prof       ON prof.vehicle_id = t.vehicle_id
       JOIN LATERAL (
         SELECT max(lph) AS peak_lph,
                max(drop_ml) FILTER (WHERE lph = max_lph) AS peak_drop_ml,
                max(gap_s)   FILTER (WHERE lph = max_lph) AS peak_gap_s
           FROM (
             SELECT drop_ml, gap_s, lph, max(lph) OVER () AS max_lph FROM (
               SELECT
                 lag(fuel_level_ml) OVER w - fuel_level_ml AS drop_ml,
                 extract(epoch FROM (captured_at - lag(captured_at) OVER w)) AS gap_s,
                 CASE WHEN extract(epoch FROM (captured_at - lag(captured_at) OVER w))
                             BETWEEN ${MIN_GAP} AND 300
                      THEN (lag(fuel_level_ml) OVER w - fuel_level_ml) / 1000.0
                           / (extract(epoch FROM (captured_at - lag(captured_at) OVER w)) / 3600.0)
                 END AS lph
                 FROM vehicle_telemetries tt
                WHERE tt.vehicle_id = t.vehicle_id AND tt.fuel_level_ml IS NOT NULL
                  AND tt.captured_at >= t.began_at - interval '5 minutes'
                  AND tt.captured_at <= t.detected_at + interval '30 minutes'
               WINDOW w AS (ORDER BY captured_at)
             ) x WHERE lph > 0
           ) y
       ) s ON true
      WHERE o.code = $1 AND t.detected_at >= now() - interval '${DAYS} days'
        AND t.fall_seconds IS NOT NULL AND s.peak_lph IS NOT NULL`,
    [ORG],
  )

  const bucket = (r: { distrusted: boolean; verdict: string; verdict_reason: string }): string =>
    r.distrusted ? 'distrusted probe'
      : (r.verdict === 'DRAIN' && r.verdict_reason === 'level-stayed-down')
        ? 'TRUSTED · confirmed drain' : 'TRUSTED · other'

  const groups = new Map<string, number[]>()
  for (const r of rows) {
    const k = bucket(r)
    groups.set(k, [...(groups.get(k) ?? []), Number(r.peak_lph)])
  }
  const pct = (a: number[], p: number): number =>
    [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] ?? 0

  console.log(`\n  ${ORG} — peak single-interval rate inside the fall · ${DAYS} days · ${rows.length} drains`)
  console.log('  ' + '─'.repeat(78))
  console.log(`  ${pad('POPULATION', 28)}${pad('N', 7)}${pad('p50', 10)}${pad('p75', 10)}${pad('p90', 10)}p99`)
  console.log('  ' + '─'.repeat(78))
  for (const [k, v] of [...groups.entries()].sort()) {
    console.log(`  ${pad(k, 28)}${pad(String(v.length), 7)}${pad(n0(pct(v, 0.5)), 10)}` +
                `${pad(n0(pct(v, 0.75)), 10)}${pad(n0(pct(v, 0.9)), 10)}${n0(pct(v, 0.99))}`)
  }

  console.log(`\n  HOW MANY EACH CANDIDATE CEILING WOULD REFUSE`)
  console.log(`    ${pad('ceiling L/h', 14)}${pad('trusted confirmed', 20)}${pad('trusted other', 16)}distrusted`)
  console.log('    ' + '─'.repeat(64))
  for (const ceil of [1_000, 2_000, 3_000, 5_000, 8_000, 12_000]) {
    const over = (k: string) => (groups.get(k) ?? []).filter(v => v > ceil).length
    const tot  = (k: string) => (groups.get(k) ?? []).length || 1
    console.log(`    ${pad(String(ceil), 14)}` +
      `${pad(`${over('TRUSTED · confirmed drain')} of ${tot('TRUSTED · confirmed drain')}`, 20)}` +
      `${pad(`${over('TRUSTED · other')} of ${tot('TRUSTED · other')}`, 16)}` +
      `${over('distrusted probe')} of ${tot('distrusted probe')}`)
  }

  console.log(`\n  STEEPEST INTERVALS ON TRUSTED PROBES (top 12 by rate)`)
  console.log(`    ${pad('VEHICLE', 22)}${pad('WHEN', 14)}${pad('PEAK L/h', 11)}${pad('DROP', 9)}${pad('GAP', 8)}VERDICT`)
  const trusted = rows.filter((r: { distrusted: boolean }) => !r.distrusted)
    .sort((a: { peak_lph: number }, b: { peak_lph: number }) => Number(b.peak_lph) - Number(a.peak_lph))
  for (const r of trusted.slice(0, 12)) {
    console.log(`    ${pad(r.vehicle, 22)}${pad(r.detected, 14)}${pad(n0(r.peak_lph), 11)}` +
                `${pad((Number(r.peak_drop_ml) / 1000).toFixed(1) + ' L', 9)}` +
                `${pad(Math.round(Number(r.peak_gap_s)) + ' s', 8)}${r.verdict}/${r.drain_cause ?? '—'}`)
  }
  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
