/**
 * Re-judge drains that ALREADY carry a verdict.
 *
 * `adjudicate-fuel.ts` judges rows sitting at PENDING, which is every row the
 * live sweep has not reached yet. This one is for rows that were judged under
 * an older rule and are now wrong — the sweep will never revisit them, because
 * it selects on `verdict: 'PENDING'` and nothing moves a row back.
 *
 * Written for the OBSERVED_DROP_MIN_RATIO guard added 2026-08-08: before it, a
 * recovery ratio was measured against whatever fall our series happened to see,
 * so a few millilitres of probe noise could clear a claim of tens of litres.
 * KTCC 850B was ruled REDISTRIBUTION on 19 ml recovered against 25,830 ml
 * claimed. Those verdicts are still on the ledger and still excluded from the
 * loss figures.
 *
 * Dry run by default; prints every row whose verdict would change. Nothing is
 * deleted and no volume is edited — only the verdict, its reason, its timestamp
 * and recoveredMl.
 *
 * It NEVER notifies. These drains are days or weeks old and the feed is for
 * what is happening now; the live sweep is what announces new ones. There is no
 * --notify flag on purpose.
 *
 * Run ON THE BOX directly, not through the npm script: the wrapper sets
 * DOTENV_CONFIG_PATH=.env.example, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/readjudicate-fuel.ts --days 30
 *   npx tsx prisma/readjudicate-fuel.ts --days 30 --apply
 *   npx tsx prisma/readjudicate-fuel.ts --org SUKARI --days 60 --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { adjudicateDrain, OBSERVED_DROP_MIN_RATIO, RECOVERY_THRESHOLD, type LevelSample } from '../src/modules/fuel/fuel-adjudication.js'
import { LOOKBEHIND_MS, LOOKAHEAD_MS } from '../src/modules/fuel/fuel-adjudication.service.js'

const argv  = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag  = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null
}
const ONLY_ORG = flag('org')?.toUpperCase() ?? null
const DAYS     = Number(flag('days') ?? 30)
const LIMIT    = Number(flag('limit') ?? 2000)

const L = (ml: number) => `${(ml / 1000).toFixed(1)} L`

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 3600_000)
  console.log(`\n⛽  re-judging drains already given a verdict  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
  console.log(`    window ${DAYS} days (since ${since.toISOString().slice(0, 10)}) · recovery ${(RECOVERY_THRESHOLD * 100).toFixed(0)}% · observed drop ≥ ${(OBSERVED_DROP_MIN_RATIO * 100).toFixed(0)}% of claim\n`)

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true, name: true } })
  const now  = new Date()
  let grandChanged = 0, grandExamined = 0, grandMlBackIntoLoss = 0

  for (const org of orgs) {
    if (ONLY_ORG && org.code !== ONLY_ORG) continue

    const rows = await prisma.fuelTheft.findMany({
      // PENDING belongs to the live sweep; this is only for settled verdicts.
      where: {
        verdict:    { in: ['LOSS', 'REDISTRIBUTION', 'UNVERIFIED'] },
        beganAt:    { gte: since },
        vehicle:    { organisationId: org.id },
      },
      select: {
        id: true, vehicleId: true, beganAt: true, detectedAt: true, stolenMl: true,
        verdict: true, verdictReason: true, recoveredMl: true,
        vehicle: { select: { registrationPlate: true } },
      },
      orderBy: { beganAt: 'desc' },
      take: LIMIT,
    })
    if (rows.length === 0) continue

    const changes: string[] = []
    const matrix: Record<string, number> = {}
    let mlBackIntoLoss = 0

    for (const t of rows) {
      grandExamined++

      // The SAME windows the service reads, imported rather than copied so the
      // two cannot drift apart into disagreeing about the same drain.
      const from = new Date(t.beganAt.getTime() - LOOKBEHIND_MS)
      const to   = new Date(t.detectedAt.getTime() + LOOKAHEAD_MS)

      const [levels, filling] = await Promise.all([
        prisma.vehicleTelemetry.findMany({
          where:   { vehicleId: t.vehicleId, capturedAt: { gte: from, lte: to }, fuelLevelMl: { not: null } },
          select:  { capturedAt: true, fuelLevelMl: true },
          orderBy: { capturedAt: 'asc' },
        }),
        prisma.fuelFilling.findFirst({
          where:   { vehicleId: t.vehicleId, filledAt: { gte: t.beganAt, lte: to } },
          select:  { filledAt: true },
          orderBy: { filledAt: 'asc' },
        }),
      ])
      const samples: LevelSample[] = levels.map(r => ({ capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl! }))

      const next = adjudicateDrain(
        { beganAt: t.beganAt, detectedAt: t.detectedAt, stolenMl: t.stolenMl },
        samples, filling?.filledAt ?? null, now,
      )
      // A row cannot go BACK to pending: it has long outlived its settle window,
      // and writing PENDING would hand it to the live sweep as if it were new.
      if (next.verdict === 'PENDING') continue

      const key = `${t.verdict} → ${next.verdict}`
      matrix[key] = (matrix[key] ?? 0) + 1
      if (next.verdict === t.verdict) continue

      // Volume that stops being written off and goes back into the loss figures.
      if (t.verdict === 'REDISTRIBUTION' && next.verdict !== 'REDISTRIBUTION') mlBackIntoLoss += t.stolenMl

      changes.push(
        `     ${t.vehicle.registrationPlate.padEnd(10)} ${t.beganAt.toISOString().slice(0, 16).replace('T', ' ')}  ` +
        `${L(t.stolenMl).padStart(8)} claimed  ${t.verdict} (${t.verdictReason ?? '—'}, ` +
        `${t.recoveredMl != null ? L(t.recoveredMl) : 'no figure'} back)  →  ${next.verdict} (${next.reason})`,
      )
      grandChanged++

      if (!APPLY) continue
      await prisma.fuelTheft.update({
        where: { id: t.id },
        data:  { verdict: next.verdict, verdictAt: now, recoveredMl: next.recoveredMl, verdictReason: next.reason },
      })
    }

    console.log(`  ── ${org.code} (${org.name}) · ${rows.length} judged rows in window`)
    for (const [k, n] of Object.entries(matrix).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)}  ${k}${k.split(' → ')[0] === k.split(' → ')[1] ? '  (unchanged)' : ''}`)
    }
    if (changes.length) {
      console.log(`\n     changed:`)
      for (const c of changes) console.log(c)
      console.log(`\n     ${L(mlBackIntoLoss)} stops being excluded from the loss figures`)
    }
    console.log()
    grandMlBackIntoLoss += mlBackIntoLoss
  }

  console.log(`  ── total: ${grandExamined} examined · ${grandChanged} would change · ${L(grandMlBackIntoLoss)} back into the loss figures`)
  if (!APPLY) console.log('\n  Dry run — nothing written. Re-run with --apply\n')
  else console.log('\n  Applied. No notifications were published.\n')
}

main()
  .catch(err => { console.error('\n❌  readjudicate-fuel failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
