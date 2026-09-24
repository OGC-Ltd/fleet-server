/**
 * What is actually in the 10-15 L band that `SIPHON_MIN_DROP_ML` excludes?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The claim under test
 *
 * The floor is 15 L, defended as a guard against "thermal contraction and
 * ordinary probe drift", and deliberately a flat volume rather than a share of
 * tank capacity because `vehicles.tankCapacityLitres` disagrees with the probes
 * on 180 of 299 units.
 *
 * 176 drains over 30 days sit in the 10-15 L band it excludes, and one of them
 * is MUFINDI - EX 16's 11 L on 2026-09-24, which alerted nobody. Lowering the
 * floor is only worth it if that band contains events rather than noise, so
 * this asks what is in it — split by the two things that decide whether a small
 * drop means anything: whether the probe is trusted, and whether the machine
 * was standing still with its engine measured off.
 *
 * ## The physics the floor is guarding against
 *
 * Diesel contracts about 0.00083 per degree C. On an 84 L tractor tank a 20 C
 * overnight swing is ~1.4 L; on a 400 L truck it is ~6.6 L. So a FLAT floor is
 * necessarily either too low for the big tanks or too high for the small ones,
 * which is the case for making it per-probe rather than per-fleet.
 *
 *   npx tsx prisma/measure-drop-floor.ts --org=KASULU --days=30 --tunnel
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG    = arg('org') ?? 'KASULU'
const DAYS   = Number(arg('days') ?? 30)
const TUNNEL = process.argv.includes('--tunnel')

function connectionString(): string {
  const u = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!)
  if (TUNNEL) { u.hostname = 'localhost'; u.port = '15432' }
  return u.toString()
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

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
              count(*) FILTER (WHERE swing >= 25000) AS swinging,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY swing) AS p90
         FROM spans GROUP BY vehicle_id
     )
     SELECT v.name AS vehicle, v.tank_capacity_litres AS tank,
            t.stolen_ml, t.verdict, t.verdict_reason, t.drain_cause, t.cause_reason,
            t.engine_evidence, t.fall_distance_km, t.fall_seconds,
            coalesce(prof.p90, 0) AS p90,
            (coalesce(prof.swinging,0) >= 3
              AND coalesce(prof.swinging,0)::float / greatest(coalesce(prof.windows,1),1) >= 0.05)
              AS distrusted
       FROM fuel_thefts t
       JOIN vehicles v      ON v.id = t.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN prof       ON prof.vehicle_id = t.vehicle_id
      WHERE o.code = $1 AND t.detected_at >= now() - interval '${DAYS} days'
        AND t.stolen_ml < 20000`,
    [ORG],
  )

  const band = (ml: number): string =>
    ml < 10_000 ? 'under 10 L' : ml < 12_500 ? '10.0-12.5 L'
    : ml < 15_000 ? '12.5-15.0 L' : '15.0-20.0 L'

  interface Cell { n: number; trusted: number; parked: number; both: number; ml: number }
  const cells = new Map<string, Cell>()
  for (const r of rows) {
    const k = band(Number(r.stolen_ml))
    const cur = cells.get(k) ?? { n: 0, trusted: 0, parked: 0, both: 0, ml: 0 }
    const trusted = !r.distrusted
    // The live watcher's own precondition: standing still, engine MEASURED off.
    const parked = Number(r.engine_evidence ?? 0) >= 0.5 && Number(r.fall_distance_km ?? 0) === 0
    cur.n++; cur.ml += Number(r.stolen_ml)
    if (trusted) cur.trusted++
    if (parked) cur.parked++
    if (trusted && parked) cur.both++
    cells.set(k, cur)
  }

  console.log(`\n  ${ORG} — drains under 20 L · ${DAYS} days · ${rows.length} rows`)
  console.log('  ' + '─'.repeat(78))
  console.log(`  ${pad('BAND', 15)}${pad('DRAINS', 9)}${pad('TRUSTED', 10)}${pad('PARKED', 9)}${pad('BOTH', 8)}VOLUME`)
  console.log('  ' + '─'.repeat(78))
  for (const k of ['under 10 L', '10.0-12.5 L', '12.5-15.0 L', '15.0-20.0 L']) {
    const c = cells.get(k)
    if (!c) { console.log(`  ${pad(k, 15)}0`); continue }
    console.log(`  ${pad(k, 15)}${pad(String(c.n), 9)}${pad(String(c.trusted), 10)}` +
                `${pad(String(c.parked), 9)}${pad(String(c.both), 8)}${(c.ml / 1000).toFixed(0)} L`)
  }

  // The band that would be admitted, and what it is made of.
  const admitted = rows.filter((r: Record<string, unknown>) =>
    Number(r['stolen_ml']) >= 10_000 && Number(r['stolen_ml']) < 15_000)
  const clean = admitted.filter((r: Record<string, unknown>) =>
    !r['distrusted'] && Number(r['engine_evidence'] ?? 0) >= 0.5 &&
    Number(r['fall_distance_km'] ?? 0) === 0)

  console.log(`\n  IF THE FLOOR MOVED 15 L -> 10 L`)
  console.log(`    drains admitted                       ${admitted.length}`)
  console.log(`    …on a trusted probe, parked, engine measured off  ${clean.length}`)
  console.log(`    …the rest (noise, or unjudgeable)     ${admitted.length - clean.length}`)

  if (clean.length > 0) {
    console.log(`\n    THE CANDIDATES — small drops that look like events`)
    console.log(`      ${pad('VEHICLE', 24)}${pad('DROP', 9)}${pad('TANK', 9)}${pad('p90 SWING', 12)}CURRENT CAUSE`)
    for (const r of clean.slice(0, 20)) {
      console.log(`      ${pad(String(r['vehicle']), 24)}` +
                  `${pad((Number(r['stolen_ml']) / 1000).toFixed(1) + ' L', 9)}` +
                  `${pad(String(r['tank'] ?? '—') + ' L', 9)}` +
                  `${pad((Number(r['p90']) / 1000).toFixed(2) + ' L', 12)}` +
                  `${r['drain_cause'] ?? '—'}/${r['cause_reason'] ?? '—'}`)
    }
    if (clean.length > 20) console.log(`      …and ${clean.length - 20} more`)
  }

  // Per-probe framing: how many of the candidates are a big multiple of their
  // own probe's measured noise, which is the test a flat floor cannot make.
  const vsNoise = clean.map((r: Record<string, unknown>) => {
    const p90 = Number(r['p90'])
    return p90 > 0 ? Number(r['stolen_ml']) / p90 : Infinity
  }).filter(n => Number.isFinite(n)).sort((a, b) => a - b)
  if (vsNoise.length) {
    const q = (p: number) => vsNoise[Math.floor((vsNoise.length - 1) * p)]!.toFixed(0)
    console.log(`\n    drop ÷ that probe's own p90 parked swing:  ` +
                `p25 ${q(0.25)}x · p50 ${q(0.5)}x · p75 ${q(0.75)}x`)
    console.log(`    (a flat floor cannot ask this question — see the header)`)
  }
  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
