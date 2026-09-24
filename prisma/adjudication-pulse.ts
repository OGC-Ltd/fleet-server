/**
 * Is the adjudication pass actually running?
 *
 * A row stuck on PENDING past its ripeness has two quite different
 * explanations: the quarter-hourly cycle has not come round yet, or the pass
 * is not running on the box at all (`FUEL_ADJUDICATION_ENABLED=false`, a
 * failing cycle, or no Redis so the BullMQ repeatable never registered).
 *
 * Only fleet-wide freshness separates them. If other rows were judged minutes
 * ago the pass is alive and this row is simply waiting; if nothing has been
 * judged for hours, the detector is down and that is the headline, not the row.
 *
 * Read-only.
 */

import 'dotenv/config'
import { Client } from 'pg'

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

  for (const [label, table, tcol] of [
    ['FILLINGS', 'fuel_fillings', 'filled_at'],
    ['DRAINS',   'fuel_thefts',   'detected_at'],
  ] as const) {
    const { rows: [r] } = await c.query(
      `SELECT to_char(max(verdict_at) + interval '3 hours', 'DD Mon HH24:MI:SS') AS last_judged,
              round(extract(epoch from (now() - max(verdict_at)))/60) AS mins_ago,
              count(*) FILTER (WHERE verdict_at >= now() - interval '1 hour') AS judged_last_hour,
              count(*) FILTER (WHERE verdict = 'PENDING') AS pending_total
         FROM ${table}`,
    )
    console.log(`\n  ${label}`)
    console.log(`    last verdict written   ${r.last_judged ?? 'never'}  (${r.mins_ago ?? '—'} min ago)`)
    console.log(`    judged in last hour    ${r.judged_last_hour}`)
    console.log(`    still PENDING          ${r.pending_total}`)

    // PENDING rows that are already past their ripeness — the backlog the pass
    // should be clearing. Fillings ripen at 60 min, drains at 20.
    const ripeMin = table === 'fuel_fillings' ? 60 : 20
    const { rows: [b] } = await c.query(
      `SELECT count(*) AS overdue,
              to_char(min(${tcol}) + interval '3 hours', 'DD Mon HH24:MI') AS oldest
         FROM ${table}
        WHERE verdict = 'PENDING' AND ${tcol} <= now() - interval '${ripeMin} minutes'`,
    )
    console.log(`    PENDING past ripeness  ${b.overdue}${b.oldest ? `  (oldest ${b.oldest})` : ''}`)
  }

  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
