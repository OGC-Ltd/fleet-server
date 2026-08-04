/**
 * Build Trip rows from completed dispatches.
 *
 * The `trips` table was empty on every live database — the only writers were
 * the retired simulator and an unused REST endpoint — so the whole delivery
 * half of the Analytics page, the Drivers roster's trips/tonnes/mileage, and
 * the org reports all read zero. This fills the history; `lib/queues/trips.ts`
 * keeps it filled.
 *
 * The dispatch supplies who / where / when. Every distance and speed is
 * measured from the vehicle's own fixes — see lib/trip-builder.
 *
 * Idempotent through Trip.dispatchId, so re-running any window is safe.
 *
 * Run: npm run build:trips                       (dry run, all orgs, 90 days)
 *      npm run build:trips -- --apply
 *      npm run build:trips -- --org SUKARI --days 30 --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { buildTripsForOrg } from '../src/lib/trip-builder.js'

const argv  = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag  = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null
}
const DAYS     = Number(flag('days') ?? 90)
const ONLY_ORG = flag('org')?.toUpperCase() ?? null
const LIMIT    = flag('limit') ? Number(flag('limit')) : undefined

async function main() {
  if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error(`--days must be positive, got ${flag('days')}`)

  const to   = new Date()
  const from = new Date(to.getTime() - DAYS * 86_400_000)

  console.log(`\n🚚  completed dispatches → trips  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
  console.log(`    window: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}  (${DAYS}d)\n`)

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true, name: true } })
  let grandBuilt = 0, grandSkipped = 0

  for (const org of orgs) {
    if (ONLY_ORG && org.code !== ONLY_ORG) continue

    const closed = await prisma.dispatch.count({
      where: { organisationId: org.id, vehicleId: { not: null },
               actualReturnAt: { not: null, gte: from, lte: to } },
    })
    if (closed === 0) continue

    const out = await buildTripsForOrg(org.id, { from, to, apply: APPLY, limit: LIMIT })

    console.log(`  ── ${org.code} (${org.name})`)
    console.log(`     ${closed} completed dispatch(es) in the window`)
    console.log(`     ${out.built} trip(s) ${APPLY ? 'written' : 'to write'}`)
    // Not a failure — it is the honest reason the delivery totals sit below the
    // dispatch totals, and it must be visible rather than inferred from a gap.
    if (out.skipped > 0) {
      console.log(`     ${out.skipped} skipped — too few fixes in the window to measure a distance`)
    }
    console.log()

    grandBuilt   += out.built
    grandSkipped += out.skipped
  }

  console.log(`  ── total: ${grandBuilt} trip(s) ${APPLY ? 'written' : 'pending'}${grandSkipped ? `, ${grandSkipped} unmeasurable` : ''}`)
  if (!APPLY) console.log('\n  Dry run — nothing written. Re-run with:  npm run build:trips -- --apply')
  console.log()
}

main()
  .catch(err => { console.error('\n❌  build-trips failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
