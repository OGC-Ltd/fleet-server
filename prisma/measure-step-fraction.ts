/**
 * Does `stepFraction` still separate anything once the trust gate has run?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The claim under test
 *
 * `SIPHON_MAX_STEP_FRACTION = 0.6` is defended in `fuel-theft-classifier` by a
 * measurement: "Confirmed drains are the least steppy population on the ledger
 * (p50 0.25) while the distrusted-probe population is the steppiest (0.42) — so
 * on this fleet a step indicates the instrument, not a thief."
 *
 * That separation was measured across the WHOLE ledger. But `probeSwings` runs
 * at gate 1 and returns INDETERMINATE before any question about the fall is
 * asked, so the distrusted population never reaches the step test at all. The
 * test therefore operates on a population its own calibration excluded.
 *
 * If the separation survives among trusted probes, the constant is doing real
 * work and should stay. If it does not, it is discriminating on an axis that no
 * longer varies where it is applied.
 *
 * `fuel-drop-shape`'s own docstring already says the quantity "measures the
 * shape and says nothing about the cause", and that telling a sharp siphon from
 * a probe glitch "is the recovery test's job, which has already run by the time
 * a drop reaches here". The two modules disagree; this is the arbiter.
 *
 *   npx tsx prisma/measure-step-fraction.ts --org=KASULU --days=30 --tunnel
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
const q = (v: unknown): string => v == null ? '—' : Number(v).toFixed(3)

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
              count(*) FILTER (WHERE swing >= 25000) AS swinging
         FROM spans GROUP BY vehicle_id
     ), d AS (
       SELECT t.step_fraction, t.verdict, t.verdict_reason, t.drain_cause,
              (coalesce(prof.swinging,0) >= 3
                AND coalesce(prof.swinging,0)::float / greatest(coalesce(prof.windows,1),1) >= 0.05)
                AS distrusted
         FROM fuel_thefts t
         JOIN vehicles v      ON v.id = t.vehicle_id
         JOIN organisations o ON o.id = v.organisation_id
         LEFT JOIN prof       ON prof.vehicle_id = t.vehicle_id
        WHERE o.code = $1 AND t.detected_at >= now() - interval '${DAYS} days'
          AND t.step_fraction IS NOT NULL
     )
     SELECT distrusted,
            CASE WHEN verdict = 'DRAIN' AND verdict_reason = 'level-stayed-down'
                 THEN 'confirmed drain' ELSE 'everything else' END AS population,
            count(*) AS n,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY step_fraction) AS p25,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY step_fraction) AS p50,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY step_fraction) AS p75,
            count(*) FILTER (WHERE step_fraction > 0.6) AS over_threshold
       FROM d GROUP BY 1, 2 ORDER BY 1, 2`,
    [ORG],
  )

  console.log(`\n  ${ORG} — step fraction by population · ${DAYS} days`)
  console.log('  ' + '─'.repeat(84))
  console.log(`  ${pad('PROBE', 14)}${pad('POPULATION', 20)}${pad('N', 8)}${pad('p25', 9)}${pad('p50', 9)}${pad('p75', 9)}> 0.6`)
  console.log('  ' + '─'.repeat(84))
  for (const r of rows) {
    console.log(`  ${pad(r.distrusted ? 'distrusted' : 'TRUSTED', 14)}${pad(r.population, 20)}` +
                `${pad(String(r.n), 8)}${pad(q(r.p25), 9)}${pad(q(r.p50), 9)}${pad(q(r.p75), 9)}` +
                `${r.over_threshold} (${((Number(r.over_threshold) / Number(r.n)) * 100).toFixed(0)}%)`)
  }

  const trusted = rows.filter((r: { distrusted: boolean }) => !r.distrusted)
  const conf = trusted.find((r: { population: string }) => r.population === 'confirmed drain')
  const rest = trusted.find((r: { population: string }) => r.population === 'everything else')
  if (conf && rest) {
    console.log(`\n  AMONG TRUSTED PROBES — the population the test actually sees`)
    console.log(`    confirmed drains   p50 ${q(conf.p50)}`)
    console.log(`    everything else    p50 ${q(rest.p50)}`)
    const sep = Number(rest.p50) / Number(conf.p50)
    console.log(`    separation         ${sep.toFixed(2)}x` +
                `${Math.abs(sep - 1) < 0.25 ? '   <- no meaningful separation' : ''}`)
    console.log(`\n    Of the confirmed drains on trusted probes, ${conf.over_threshold} of ${conf.n} ` +
                `(${((Number(conf.over_threshold) / Number(conf.n)) * 100).toFixed(0)}%) exceed 0.6`)
    console.log(`    and are therefore refused as "the instrument, not a hose".`)
  }
  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
