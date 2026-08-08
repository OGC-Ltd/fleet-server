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
 * `--recompute` switches to re-measuring `avgSpeedKmh` on trips that ALREADY
 * exist, which a plain re-run can never do (it skips every row it has written).
 * Needed once, after the average-speed definition changed from distance-over-
 * elapsed-time to the mean while moving — see lib/trip-builder.
 *
 * Run: npm run build:trips                       (dry run, all orgs, 90 days)
 *      npm run build:trips -- --apply
 *      npm run build:trips -- --org SUKARI --days 30 --apply
 *      npm run build:trips -- --recompute                (dry run)
 *      npm run build:trips -- --recompute --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { buildTripsForOrg, recomputeTripSpeeds } from '../src/lib/trip-builder.js'

const argv      = process.argv.slice(2)
const APPLY     = argv.includes('--apply')
const RECOMPUTE = argv.includes('--recompute')
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

  const headline = RECOMPUTE ? '⏱  re-measuring avgSpeedKmh on existing trips' : '🚚  completed dispatches → trips'
  console.log(`\n${headline}  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
  console.log(`    window: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}  (${DAYS}d)\n`)

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true, name: true } })

  if (RECOMPUTE) {
    let grandCorrected = 0, grandUnmeasurable = 0
    for (const org of orgs) {
      if (ONLY_ORG && org.code !== ONLY_ORG) continue

      const out = await recomputeTripSpeeds(org.id, { from, to, apply: APPLY, limit: LIMIT })
      if (out.corrected + out.unchanged + out.unmeasurable === 0) continue

      console.log(`  ── ${org.code} (${org.name})`)
      console.log(`     ${out.corrected} trip(s) ${APPLY ? 'corrected' : 'to correct'}`)
      console.log(`     ${out.unchanged} already correct`)
      // Fixes aged out of retention since the trip was built. The stored value
      // is kept — losing the source data is not evidence it was wrong.
      if (out.unmeasurable > 0) {
        console.log(`     ${out.unmeasurable} left alone — no usable fixes left in the trip window`)
      }
      console.log()

      grandCorrected    += out.corrected
      grandUnmeasurable += out.unmeasurable
    }
    console.log(`  ── total: ${grandCorrected} trip(s) ${APPLY ? 'corrected' : 'pending'}${grandUnmeasurable ? `, ${grandUnmeasurable} unmeasurable` : ''}`)
    if (!APPLY) console.log('\n  Dry run — nothing written. Re-run with:  npm run build:trips -- --recompute --apply')
    console.log()
    return
  }

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
