/**
 * Is the truncation spread across the fleet, or concentrated on a few probes?
 *
 * Depends on nothing but the four ledger facts that define the signature, so it
 * stands whatever happens to the PROBE/REAL classification in
 * `truncation-sweep.ts` — which does NOT stand, because its net-change window
 * assumes one drain and one filling per episode and the ledger is heavily
 * clustered.
 *
 * Also reports how many of each vehicle's drains arrive in CLUSTERS — two or
 * more inside an hour — because that is both the thing that breaks the net
 * measurement and, on its own, a signal about the instrument.
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

const L = (ml: number): string => `${(ml / 1000).toFixed(0)} L`
const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

  const { rows } = await c.query(
    `WITH flagged AS (
       SELECT t.id, t.vehicle_id, v.name AS vehicle, t.stolen_ml, t.detected_at, f.filled_ml
         FROM fuel_thefts t
         JOIN vehicles v      ON v.id = t.vehicle_id
         JOIN organisations o ON o.id = v.organisation_id
         JOIN LATERAL (
           SELECT * FROM fuel_fillings ff
            WHERE ff.vehicle_id = t.vehicle_id
              AND ff.filled_at >= t.began_at
              AND ff.filled_at <= t.detected_at + interval '3 hours'
            ORDER BY ff.filled_at ASC LIMIT 1
         ) f ON true
        WHERE o.code = $1
          AND t.detected_at >= now() - interval '${DAYS} days'
          AND t.verdict = 'DRAIN'
          AND f.verdict = 'REDISTRIBUTION'
          AND f.verdict_at > t.verdict_at
     ), gapped AS (
       SELECT *, detected_at - lag(detected_at) OVER (PARTITION BY vehicle_id ORDER BY detected_at) AS gap
         FROM flagged
     )
     SELECT vehicle, count(*) AS rows,
            sum(stolen_ml) AS drain_ml,
            count(*) FILTER (WHERE gap < interval '1 hour') AS clustered
       FROM gapped
      GROUP BY vehicle
      ORDER BY count(*) DESC`,
    [ORG],
  )

  const total     = rows.reduce((s: number, r: { rows: string }) => s + Number(r.rows), 0)
  const clustered = rows.reduce((s: number, r: { clustered: string }) => s + Number(r.clustered), 0)

  console.log(`\n  ${ORG} · ${DAYS} days — ${total} flagged rows across ${rows.length} vehicles`)
  console.log(`  ${clustered} of them (${((clustered / total) * 100).toFixed(0)}%) arrive within an hour of the same vehicle's previous one\n`)
  console.log(`  ${pad('VEHICLE', 26)}${pad('ROWS', 7)}${pad('CLUSTERED', 11)}DRAIN VOLUME`)
  console.log('  ' + '─'.repeat(62))
  let cum = 0
  for (const [i, r] of rows.entries()) {
    cum += Number(r.rows)
    if (i < 15) {
      console.log(`  ${pad(r.vehicle, 26)}${pad(String(r.rows), 7)}${pad(String(r.clustered), 11)}${L(Number(r.drain_ml))}`)
    }
    if (i === 14) {
      console.log(`  ${'─'.repeat(62)}`)
      console.log(`  top 15 account for ${cum} of ${total} rows (${((cum / total) * 100).toFixed(0)}%)`)
    }
  }
  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
