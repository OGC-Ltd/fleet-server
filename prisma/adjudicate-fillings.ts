/**
 * Judge Wialon's refuelling claims against our own tank readings.
 *
 * Dry run by default. Nothing is deleted and no volume is edited: `filledMl`
 * stays exactly as the provider reported it, and `observedRiseMl` records what
 * our telemetry actually saw, so the two can always be compared.
 *
 * Run ON THE BOX directly, not through an npm wrapper — those point
 * DOTENV_CONFIG_PATH at .env, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/adjudicate-fillings.ts
 *   npx tsx prisma/adjudicate-fillings.ts --apply
 *   npx tsx prisma/adjudicate-fillings.ts --rejudge --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { adjudicateFillings } from '../src/modules/fuel/fuel-filling-adjudication.service.js'
import { FILL_OBSERVED_MIN_RATIO } from '../src/modules/fuel/fuel-filling-adjudication.js'

const argv    = process.argv.slice(2)
const APPLY   = argv.includes('--apply')
const REJUDGE = argv.includes('--rejudge')
const i       = argv.indexOf('--org')
const ORG     = i >= 0 && argv[i + 1] ? argv[i + 1]!.toUpperCase() : null

async function main() {
  console.log(`\n⛽  adjudicating fuel fillings  ${APPLY ? '(APPLYING)' : '(dry run)'}${REJUDGE ? ' · re-judging settled rows' : ''}`)
  console.log(`    a filling is corroborated when our own levels rise by >= ${(FILL_OBSERVED_MIN_RATIO * 100).toFixed(0)}% of the claim\n`)

  const orgId = ORG
    ? (await prisma.organisation.findFirst({ where: { code: ORG }, select: { id: true } }))?.id
    : undefined
  if (ORG && !orgId) throw new Error(`no organisation with code ${ORG}`)

  const out = await adjudicateFillings({ orgId, apply: APPLY, rejudge: REJUDGE })
  const L = (ml: number) => `${(ml / 1000).toFixed(0)} L`

  console.log(`  ${out.examined} fillings examined`)
  console.log(`  ${out.refillConfirmed} confirmed — our own levels watched the fuel arrive`)
  console.log(`  ${out.refillUnchecked} unchecked — no telemetry to corroborate, claim relayed`)
  console.log(`  ${out.redistribution} undulation — fuel supposedly went in and the tank is no fuller`)
  if (out.stillPending > 0) console.log(`  ${out.stillPending} still settling`)
  console.log(`\n  ${L(out.uncorroboratedMl)} of claimed fuel-in is not corroborated by our telemetry`)
  if (!APPLY) console.log('\n  Dry run — nothing written. Re-run with --apply\n')
  else console.log('\n  Applied.\n')
}

main()
  .catch(err => { console.error('\n❌  adjudicate-fillings failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
