/**
 * Judge fuel drains against our own tank readings.
 *
 * The in-process pass (lib/queues/fuel-events) handles new drains once their
 * settle window elapses. This is for the HISTORY — every row already on the
 * ledger, written before adjudication existed, sitting at PENDING and counting
 * as a loss.
 *
 * Dry run by default. Nothing is ever deleted: a row is confirmed, reclassified
 * as redistribution, or marked unverified, and only redistribution is excluded
 * from the loss figures.
 *
 * Run: npm run fuel:adjudicate                        (dry run, all orgs)
 *      npm run fuel:adjudicate -- --apply
 *      npm run fuel:adjudicate -- --org SUKARI --limit 500 --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { adjudicatePendingDrains } from '../src/modules/fuel/fuel-adjudication.service.js'
import { SETTLE_MINUTES, RECOVERY_THRESHOLD } from '../src/modules/fuel/fuel-adjudication.js'

const argv  = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag  = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null
}
const ONLY_ORG = flag('org')?.toUpperCase() ?? null
const LIMIT    = Number(flag('limit') ?? 2000)

async function main() {
  console.log(`\n⛽  adjudicating fuel drains  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
  console.log(`    settle window ${SETTLE_MINUTES} min · recovery threshold ${(RECOVERY_THRESHOLD * 100).toFixed(0)}%\n`)

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true, name: true } })
  let grandRedistributed = 0, grandRecoveredMl = 0, grandDrain = 0, grandRefill = 0

  for (const org of orgs) {
    if (ONLY_ORG && org.code !== ONLY_ORG) continue

    const pending = await prisma.fuelTheft.count({
      where: { verdict: 'PENDING', vehicle: { organisationId: org.id } },
    })
    if (pending === 0) continue

    // Never notify from the backfill. These drains are days or weeks old; the
    // feed is for what is happening now, and republishing history would bury
    // it. The in-process pass is what announces live ones.
    const out = await adjudicatePendingDrains({
      orgId: org.id, apply: APPLY, notify: false, limit: LIMIT,
    })

    const decidable = out.drainConfirmed + out.redistribution
    console.log(`  ── ${org.code} (${org.name})`)
    console.log(`     ${pending} pending · ${out.examined} examined this pass`)
    console.log(`     ${out.drain} drain (${out.drainConfirmed} confirmed by our own levels)`)
    console.log(`     ${out.redistribution} redistribution — ${(out.recoveredMl / 1000).toFixed(0)} L that never left the tank`)
    console.log(`     ${out.refill} refill (a filling explains it)`)
    if (decidable > 0) {
      console.log(`     → ${((out.redistribution / decidable) * 100).toFixed(0)}% of decidable events were undulation, not a drain`)
    }
    if (out.stillPending > 0) console.log(`     ${out.stillPending} still inside their settle window`)
    console.log()

    grandRedistributed += out.redistribution
    grandRecoveredMl   += out.recoveredMl
    grandDrain         += out.drain
    grandRefill        += out.refill
  }

  console.log(`  ── total: ${grandDrain} drain · ${grandRedistributed} redistribution (${(grandRecoveredMl / 1000).toFixed(0)} L) · ${grandRefill} refill`)
  if (!APPLY) console.log('\n  Dry run — nothing written. Re-run with:  npm run fuel:adjudicate -- --apply')
  console.log()
}

main()
  .catch(err => { console.error('\n❌  adjudicate-fuel failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
