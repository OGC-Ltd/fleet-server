/**
 * Which vehicles can never satisfy the parked gate — measured from what we
 * STORED, not from what the provider's sensor list implies.
 *
 * `prisma/ignition-check.ts` asks `readIgnition()` about each unit's `lmsg`.
 * That turned out to be the wrong question: CTR 19's sensor is bound to
 * `pwr_ext` and `readIgnition()` returns null for it, yet every one of its
 * 3,674 stored readings carries `ignition_known = true`. The adapter resolves
 * ignition by a path the lmsg check does not reproduce, so the "110 unreadable"
 * figure that check produced overstates the problem.
 *
 * This asks the only question that matters for the classifier: over real stored
 * telemetry, does `ignition_known` ever come back true? `engineEvidence` is
 * computed from exactly that column, and `parked` — the sole route to SIPHON —
 * needs it at 0.5 or better.
 *
 * Read-only.
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG  = arg('org') ?? 'KASULU'
const DAYS = Number(arg('days') ?? 2)
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
    `SELECT v.name,
            count(*) AS readings,
            count(*) FILTER (WHERE (r.payload->>'ignition_known')::boolean IS TRUE)  AS known_true,
            count(*) FILTER (WHERE (r.payload->>'ignition_known')::boolean IS FALSE) AS known_false,
            count(*) FILTER (WHERE (r.payload->>'ignition_known') IS NULL)           AS absent
       FROM vehicle_telemetries t
       JOIN vehicles v      ON v.id = t.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
      WHERE o.code = $1 AND t.captured_at >= now() - interval '${DAYS} days'
      GROUP BY v.name
     HAVING count(*) >= 50
      ORDER BY (count(*) FILTER (WHERE (r.payload->>'ignition_known')::boolean IS TRUE))::float / count(*), v.name`,
    [ORG],
  )

  const blind = rows.filter((r: { known_true: string }) => Number(r.known_true) === 0)

  console.log(`\n  ${ORG} — ignition as STORED, last ${DAYS} days (${rows.length} vehicles reporting)`)
  console.log(`  ${'═'.repeat(70)}`)
  console.log(`  vehicles with usable ignition          ${rows.length - blind.length}`)
  console.log(`  vehicles that NEVER report it true     ${blind.length}   <- cannot ever reach SIPHON`)
  console.log(`\n  ${pad('VEHICLE', 30)}${pad('READINGS', 10)}${pad('true', 8)}${pad('false', 8)}absent`)
  console.log('  ' + '─'.repeat(66))
  for (const r of blind.slice(0, 40)) {
    console.log(`  ${pad(r.name, 30)}${pad(String(r.readings), 10)}${pad(String(r.known_true), 8)}` +
                `${pad(String(r.known_false), 8)}${r.absent}`)
  }
  if (blind.length > 40) console.log(`  …and ${blind.length - 40} more`)
  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
