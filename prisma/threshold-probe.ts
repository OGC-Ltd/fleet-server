/**
 * What would a 5 L floor and a 120 s floor actually let in?
 *
 * `SIPHON_MIN_DROP_ML` is 15 L and `SIPHON_MIN_SECONDS` 600, both chosen as
 * fleet constants. Neither was measured against the population they exclude,
 * so this counts it: how many drains sit in the bands those constants throw
 * away, and — the part that decides whether they are safe to lower — how steady
 * the probes reporting them are.
 *
 * A threshold that is right for DZ 14 (p90 parked swing 74 L) is absurd for
 * MTR 09 (p90 0.1 L). The question is not "5 or 15" but "is a fleet constant
 * the right shape at all".
 *
 * Read-only.
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG  = arg('org') ?? 'KASULU'
const DAYS = Number(arg('days') ?? 30)
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

  // Per-probe steadiness, so every count below can be split by whether the
  // instrument is worth believing at all.
  await c.query(`
    CREATE TEMP VIEW steady AS
    WITH parked AS (
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
    )
    SELECT vehicle_id,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY swing) AS p90,
           count(*) FILTER (WHERE swing >= 25000) AS swinging
      FROM spans GROUP BY vehicle_id`)

  // ── 1. the volume band ───────────────────────────────────────────────────
  const { rows: bands } = await c.query(
    `SELECT CASE
              WHEN t.stolen_ml <  5000 THEN 'a. under 5 L'
              WHEN t.stolen_ml < 10000 THEN 'b. 5-10 L'
              WHEN t.stolen_ml < 15000 THEN 'c. 10-15 L   <- excluded by the 15 L floor'
              ELSE                          'd. 15 L +'
            END AS band,
            count(*) AS drains,
            count(*) FILTER (WHERE coalesce(s.p90,0) <= 2000 AND coalesce(s.swinging,0) = 0) AS on_steady_probe,
            round(sum(t.stolen_ml)/1000.0) AS litres
       FROM fuel_thefts t
       JOIN vehicles v      ON v.id = t.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN steady s   ON s.vehicle_id = t.vehicle_id
      WHERE o.code = $1 AND t.detected_at >= now() - interval '${DAYS} days'
      GROUP BY 1 ORDER BY 1`,
    [ORG],
  )
  console.log(`\n  DROP VOLUME — ${ORG}, ${DAYS} days`)
  console.log(`  ${pad('BAND', 40)}${pad('DRAINS', 9)}${pad('ON STEADY PROBE', 18)}LITRES`)
  console.log('  ' + '─'.repeat(78))
  for (const b of bands) {
    console.log(`  ${pad(b.band, 40)}${pad(String(b.drains), 9)}${pad(String(b.on_steady_probe), 18)}${b.litres} L`)
  }

  // ── 2. the duration band ─────────────────────────────────────────────────
  const { rows: dur } = await c.query(
    `SELECT CASE
              WHEN t.fall_seconds <  60 THEN 'a. under 60 s'
              WHEN t.fall_seconds < 120 THEN 'b. 60-120 s'
              WHEN t.fall_seconds < 300 THEN 'c. 120-300 s  <- excluded by the 600 s floor'
              WHEN t.fall_seconds < 600 THEN 'd. 300-600 s  <- excluded by the 600 s floor'
              ELSE                           'e. 600 s +'
            END AS band,
            count(*) AS drains,
            count(*) FILTER (WHERE coalesce(s.p90,0) <= 2000 AND coalesce(s.swinging,0) = 0) AS on_steady_probe,
            count(*) FILTER (WHERE t.step_fraction > 0.6) AS would_fail_step
       FROM fuel_thefts t
       JOIN vehicles v      ON v.id = t.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN steady s   ON s.vehicle_id = t.vehicle_id
      WHERE o.code = $1 AND t.detected_at >= now() - interval '${DAYS} days'
        AND t.fall_seconds IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [ORG],
  )
  console.log(`\n  FALL DURATION`)
  console.log(`  ${pad('BAND', 40)}${pad('DRAINS', 9)}${pad('ON STEADY PROBE', 18)}ALSO FAIL step>0.6`)
  console.log('  ' + '─'.repeat(88))
  for (const b of dur) {
    console.log(`  ${pad(b.band, 40)}${pad(String(b.drains), 9)}${pad(String(b.on_steady_probe), 18)}${b.would_fail_step}`)
  }

  // ── 3. how coarsely do these probes report? ──────────────────────────────
  // stepFraction is meant to say "a hose cannot empty a tank between two
  // pings". That only holds if pings are close together. If the probe reports
  // on CHANGE, a big step measures the sensor, not the draw rate.
  const { rows: [gap] } = await c.query(
    `WITH g AS (
       SELECT extract(epoch from (captured_at - lag(captured_at)
                OVER (PARTITION BY vehicle_id ORDER BY captured_at))) AS dt,
              abs(fuel_level_ml - lag(fuel_level_ml)
                OVER (PARTITION BY vehicle_id ORDER BY captured_at)) AS dl
         FROM vehicle_telemetries t
         JOIN vehicles v ON v.id = t.vehicle_id
         JOIN organisations o ON o.id = v.organisation_id
        WHERE o.code = $1 AND t.captured_at >= now() - interval '2 days'
          AND t.fuel_level_ml IS NOT NULL
     )
     SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dt)) AS median_gap_s,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dl) FILTER (WHERE dl > 0)) AS median_move_ml,
            round(percentile_cont(0.99) WITHIN GROUP (ORDER BY dl)) AS p99_move_ml,
            count(*) FILTER (WHERE dl > 10000 AND dt <= 30) AS jumps_over_10L_in_30s
       FROM g WHERE dt IS NOT NULL AND dt < 600`,
    [ORG],
  )
  console.log(`\n  PROBE REPORTING GRANULARITY (2 days)`)
  console.log(`    median gap between readings        ${gap.median_gap_s} s`)
  console.log(`    median non-zero level move         ${(Number(gap.median_move_ml)/1000).toFixed(2)} L`)
  console.log(`    p99 level move between readings    ${(Number(gap.p99_move_ml)/1000).toFixed(1)} L`)
  console.log(`    moves >10 L inside 30 s            ${gap.jumps_over_10L_in_30s}   <- faster than any hose or pump`)
  console.log('')

  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
