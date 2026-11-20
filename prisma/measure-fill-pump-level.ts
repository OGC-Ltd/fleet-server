/**
 * What does reading the level at the pump as the lowest level the tank held
 * (FILL_PUMP_LEVEL_RANK) change on the ledger?
 *
 * READ-ONLY. It writes nothing and changes nothing: every settled filling in
 * the period is judged again with the code as it stands (judgeFilling, the
 * same telemetry read and probe profile the sweep uses) and set beside the
 * verdict and observed rise already stored on it, which the old rule wrote.
 *
 * MUFINDI - EX 21, 20 Nov 2026, is the row that started it: 284.3 L claimed,
 * 209.6 L observed under the old rule, about 278 L under the new one.
 *
 * Run ON THE BOX directly, like adjudicate-fillings:
 *
 *   npx tsx prisma/measure-fill-pump-level.ts --org=KASULU --days=14
 *
 * Then, to write the new judgements: prisma/adjudicate-fillings.ts --rejudge
 * (dry run first, then --apply).
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { judgeFilling } from '../src/modules/fuel/fuel-filling-adjudication.service.js'
import { FILL_HOLD_MINUTES, FILL_SETTLE_MINUTES } from '../src/modules/fuel/fuel-filling-adjudication.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG = arg('org')?.toUpperCase() ?? 'KASULU'
const DAYS = Number(arg('days') ?? 14)
/** A change in the observed rise smaller than this is noise, not the rule. */
const MOVED_ML = 5_000

const L = (ml: number | null | undefined) => (ml == null ? '-' : `${(ml / 1000).toFixed(1)} L`)
const eat = (t: Date) => new Date(t.getTime() + 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')

async function main() {
  const org = await prisma.organisation.findFirst({ where: { code: ORG }, select: { id: true } })
  if (!org) throw new Error(`no organisation with code ${ORG}`)
  const now = new Date()
  const ripe = new Date(now.getTime() - (FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES) * 60_000)
  const rows = await prisma.fuelFilling.findMany({
    where: {
      filledAt: { gte: new Date(now.getTime() - DAYS * 86_400_000), lte: ripe },
      verdict: { not: 'PENDING' },
      vehicle: { organisationId: org.id },
    },
    select: {
      id: true, vehicleId: true, filledAt: true, filledMl: true, verdict: true, observedRiseMl: true,
      vehicle: { select: { registrationPlate: true } },
    },
    orderBy: { filledAt: 'asc' },
  })

  console.log(`\n⛽  ${ORG}: ${rows.length} settled fillings in the last ${DAYS} days, judged again (read only)\n`)
  const flips = new Map<string, number>()
  const moved: Array<{ plate: string; at: Date; claimed: number; was: number | null; now: number | null; verdict: string }> = []
  let addedMl = 0
  for (const f of rows) {
    const v = await judgeFilling({ vehicleId: f.vehicleId, filledAt: f.filledAt, filledMl: f.filledMl }, now)
    if (v.verdict === 'PENDING') continue
    const was = String(f.verdict)
    if (v.verdict !== was) flips.set(`${was} → ${v.verdict}`, (flips.get(`${was} → ${v.verdict}`) ?? 0) + 1)
    const before = f.observedRiseMl ?? null
    const after = v.recoveredMl ?? null
    if (before != null && after != null && Math.abs(after - before) >= MOVED_ML) {
      moved.push({ plate: f.vehicle.registrationPlate, at: f.filledAt, claimed: f.filledMl, was: before, now: after, verdict: v.verdict })
      addedMl += after - before
    }
  }

  console.log('  Verdicts that would change:')
  if (!flips.size) console.log('    none')
  for (const [k, n] of [...flips].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${n}`)
  console.log(`\n  Observed rise moved by ${MOVED_ML / 1000} L or more: ${moved.length} fillings, ${L(addedMl)} in all`)
  for (const m of moved.sort((a, b) => Math.abs((b.now ?? 0) - (b.was ?? 0)) - Math.abs((a.now ?? 0) - (a.was ?? 0))).slice(0, 25)) {
    console.log(`    ${m.plate.padEnd(22)} ${eat(m.at)} EAT  claimed ${L(m.claimed).padStart(8)}  was ${L(m.was).padStart(8)}  now ${L(m.now).padStart(8)}  ${m.verdict}`)
  }
  console.log('\n  Nothing written. To apply: npx tsx prisma/adjudicate-fillings.ts --rejudge, then --rejudge --apply\n')
}

main()
  .catch(err => { console.error('\n❌  measure-fill-pump-level failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
