/**
 * Does the database already carry what the pending migrations would create?
 *
 * READ-ONLY.
 *
 * `prisma migrate status` reads `_prisma_migrations`, which records intent. It
 * cannot see an object somebody created by hand, and it cannot see a recorded
 * migration whose objects were later dropped. Before applying anything to a
 * shared RDS instance, the two have to be compared — a `CREATE TABLE` against a
 * table that already exists fails the whole transaction, and a migration marked
 * applied whose column is missing fails silently at query time instead.
 */

import 'dotenv/config'
import { Client } from 'pg'

const TUNNEL = !process.argv.includes('--direct')

function connectionString(): string {
  const u = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!)
  if (TUNNEL) { u.hostname = 'localhost'; u.port = '15432' }
  return u.toString()
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

  console.log(`\n  RECORDED IN _prisma_migrations`)
  const { rows: recorded } = await c.query(
    `SELECT migration_name,
            to_char(finished_at, 'YYYY-MM-DD HH24:MI') AS finished,
            rolled_back_at IS NOT NULL AS rolled_back
       FROM _prisma_migrations
      WHERE migration_name IN ('20260922060000_user_groups',
                               '20260924120000_drain_peak_interval_lph',
                               '20261022230000_user_group_memberships',
                               '20261022233000_user_groups_organisation_scoped',
                               '20261023050000_user_group_organisations')`)
  if (recorded.length === 0) console.log('    neither is recorded')
  for (const r of recorded) {
    console.log(`    ${pad(r.migration_name, 44)}${r.finished ?? 'UNFINISHED'}` +
                `${r.rolled_back ? '  ROLLED BACK' : ''}`)
  }

  // What each migration would actually create.
  const checks: Array<[string, string, string]> = [
    ['user_groups',        'table',  `SELECT to_regclass('public.user_groups') IS NOT NULL AS ok`],
    ['user_group_memberships', 'table',
                                     `SELECT to_regclass('public.user_group_memberships') IS NOT NULL AS ok`],
    ['user_groups.organisation_id', 'column',
                                     `SELECT EXISTS(SELECT 1 FROM information_schema.columns
                                        WHERE table_name='user_groups' AND column_name='organisation_id') AS ok`],
    ['user_group_organisations', 'table',
                                     `SELECT to_regclass('public.user_group_organisations') IS NOT NULL AS ok`],
    ['fuel_thefts.peak_interval_lph', 'column',
                                     `SELECT EXISTS(SELECT 1 FROM information_schema.columns
                                        WHERE table_name='fuel_thefts' AND column_name='peak_interval_lph') AS ok`],
  ]

  console.log(`\n  PRESENT IN THE SCHEMA ITSELF`)
  let anyPresent = false, anyMissing = false
  for (const [name, kind, sql] of checks) {
    const { rows: [r] } = await c.query(sql)
    const ok = r.ok === true
    if (ok) anyPresent = true; else anyMissing = true
    console.log(`    ${pad(name, 34)}${pad(kind, 8)}${ok ? 'EXISTS' : 'missing'}`)
  }

  // The verdict needs BOTH axes. Object presence alone cannot distinguish "in
  // sync" from "applied by hand and never recorded", and those want opposite
  // commands.
  const recordedOk = recorded.filter((r: { rolled_back: boolean }) => !r.rolled_back).length
  console.log(`\n  VERDICT`)
  if (!anyPresent && recordedOk === 0) {
    console.log('    Nothing is there and nothing is recorded. Genuinely unapplied —')
    console.log('    `prisma migrate deploy` is safe and is the right command.')
  } else if (!anyMissing && recordedOk === 4) {
    console.log('    Schema and migration table agree. Nothing to do.')
  } else if (!anyMissing && recordedOk === 0) {
    console.log('    Everything is there but NOTHING is recorded: do not deploy —')
    console.log('    `prisma migrate resolve --applied <name>` records it without re-running.')
  } else if (anyMissing && anyPresent) {
    console.log('    PARTIAL — the state this script exists for. Some objects exist and')
    console.log('    some do not, so a plain deploy aborts on the first CREATE that')
    console.log('    collides and the rest never runs. Baseline what is already there')
    console.log('    with `migrate resolve --applied`, then `migrate deploy` the rest.')
  } else {
    console.log('    Schema and migration table agree. Nothing to do.')
  }
  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
