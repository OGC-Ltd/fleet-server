/**
 * Re-judge drains that ALREADY carry a verdict.
 *
 * `adjudicate-fuel.ts` judges rows sitting at PENDING, which is every row the
 * live sweep has not reached yet. This one is for rows that were judged under
 * an older rule and are now wrong — the sweep will never revisit them, because
 * it selects on `verdict: 'PENDING'` and nothing moves a row back.
 *
 * That is not a small residue. On 2026-08-11, before the first run of this
 * script, the ledger read `UNVERIFIED 1720 · LOSS 601 · REDISTRIBUTION 241 ·
 * PENDING 2` — so a rule change reached two rows out of 2,564 and every
 * improvement looked like a failed deploy. This script is what makes one
 * visible. (Those verdict names are the pre-2026-08-11 vocabulary; see
 * FuelEventVerdict for what replaced them and why.)
 *
 * Dry run by default; prints every row whose verdict would change. Nothing is
 * deleted and no volume is edited — only the verdict, its reason, its timestamp
 * and recoveredMl.
 *
 * It NEVER notifies. These drains are days or weeks old and the feed is for
 * what is happening now; the live sweep is what announces new ones. There is no
 * --notify flag on purpose.
 *
 * ## What bounds it
 *
 * Not the `--days` window, which only decides how much work to do. The bound
 * that matters is `isUncheckable`: a row judged on evidence is never replaced
 * by a verdict that reports the absence of evidence. Telemetry is not pruned
 * today — `lib/queues/retention` sweeps notifications only, and readings go
 * back to 2025-01 against a ledger starting 2026-07 — but "the level series has
 * aged out" must not be able to write off a judgement whenever that changes,
 * and per-vehicle gaps exist regardless of the global span.
 *
 * Run ON THE BOX directly, not through the npm script: the wrapper sets
 * DOTENV_CONFIG_PATH=.env.example, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/readjudicate-fuel.ts --days 45
 *   npx tsx prisma/readjudicate-fuel.ts --days 45 --apply
 *   npx tsx prisma/readjudicate-fuel.ts --org SUKARI --days 60 --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { isConfirmed, isUncheckable, OBSERVED_DROP_MIN_RATIO, RECOVERY_THRESHOLD } from '../src/modules/fuel/fuel-adjudication.js'
import { judgeDrain } from '../src/modules/fuel/fuel-adjudication.service.js'

const argv  = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag  = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null
}
const ONLY_ORG = flag('org')?.toUpperCase() ?? null
const DAYS     = Number(flag('days') ?? 30)
const LIMIT    = Number(flag('limit') ?? 5000)

const L = (ml: number) => `${(ml / 1000).toFixed(1)} L`

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 3600_000)
  console.log(`\n⛽  re-judging drains already given a verdict  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
  console.log(`    window ${DAYS} days (since ${since.toISOString().slice(0, 10)}) · recovery ${(RECOVERY_THRESHOLD * 100).toFixed(0)}% · observed drop ≥ ${(OBSERVED_DROP_MIN_RATIO * 100).toFixed(0)}% of claim\n`)

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true, name: true } })
  const now  = new Date()
  let grandChanged = 0, grandExamined = 0, grandKept = 0, grandMlBackIntoLoss = 0, grandMlWrittenOff = 0

  for (const org of orgs) {
    if (ONLY_ORG && org.code !== ONLY_ORG) continue

    const rows = await prisma.fuelTheft.findMany({
      // PENDING belongs to the live sweep; this is only for settled verdicts.
      where: {
        verdict:    { in: ['DRAIN', 'REFILL', 'REDISTRIBUTION', 'SENSOR_FAULT'] },
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
    let mlBackIntoLoss = 0, mlWrittenOff = 0, kept = 0

    for (const t of rows) {
      grandExamined++

      // The SAME evidence the live sweep reads — one function, called by both,
      // so the two cannot drift into disagreeing about the same drain.
      const next = await judgeDrain(
        { vehicleId: t.vehicleId, beganAt: t.beganAt, detectedAt: t.detectedAt, stolenMl: t.stolenMl },
        now,
      )
      // A row cannot go BACK to pending: it has long outlived its settle window,
      // and writing PENDING would hand it to the live sweep as if it were new.
      if (next.verdict === 'PENDING') continue

      // ...nor can a judgement be replaced by the absence of one. The row was
      // decided when the readings were there; that they are not there now is a
      // fact about our telemetry, not about the drain. See isUncheckable.
      if (isUncheckable(next) && isConfirmed(t.verdictReason ?? '')) {
        kept++
        continue
      }

      // Confirmation can change without the verdict changing — the probe trust
      // gate does exactly that — so the matrix keys on both.
      const label = (v: string, reason: string | null) =>
        `${v}${isConfirmed(reason ?? '') ? '' : ' (unconfirmed)'}`
      const from = label(t.verdict, t.verdictReason)
      const to   = label(next.verdict, next.reason)
      const key  = `${from} → ${to}`
      matrix[key] = (matrix[key] ?? 0) + 1
      if (from === to) continue

      // Volume that starts counting as drained, and volume that stops. Both
      // directions are reported: this script exists to make a rule change
      // visible, and showing only the flattering half of one is how a backfill
      // gets trusted more than it has earned. `countsAsDrained` mirrors
      // analytics' NO_FUEL_LEFT — a DRAIN counts, confirmed or not.
      const drained = (v: string) => v === 'DRAIN'
      if (!drained(t.verdict) && drained(next.verdict)) mlBackIntoLoss += t.stolenMl
      if (drained(t.verdict) && !drained(next.verdict)) mlWrittenOff   += t.stolenMl

      changes.push(
        `     ${t.vehicle.registrationPlate.padEnd(16)} ${t.beganAt.toISOString().slice(0, 16).replace('T', ' ')}  ` +
        `${L(t.stolenMl).padStart(8)} claimed  ${from} (${t.verdictReason ?? '—'}, ` +
        `${t.recoveredMl != null ? L(t.recoveredMl) : 'no figure'} back)  →  ${to} (${next.reason})`,
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
    if (kept > 0) console.log(`     ${String(kept).padStart(4)}  kept — no telemetry to re-judge on, verdict left as it was`)
    if (changes.length) {
      console.log(`\n     changed:`)
      for (const c of changes) console.log(c)
      console.log(`\n     ${L(mlBackIntoLoss)} starts counting as drained`)
      console.log(`     ${L(mlWrittenOff)} stops counting as drained`)
    }
    console.log()
    grandMlBackIntoLoss += mlBackIntoLoss
    grandMlWrittenOff   += mlWrittenOff
    grandKept           += kept
  }

  console.log(`  ── total: ${grandExamined} examined · ${grandChanged} would change · ${grandKept} kept for want of telemetry`)
  console.log(`     ${L(grandMlBackIntoLoss)} starts counting as drained · ${L(grandMlWrittenOff)} stops`)
  if (!APPLY) console.log('\n  Dry run — nothing written. Re-run with --apply\n')
  else console.log('\n  Applied. No notifications were published.\n')
}

main()
  .catch(err => { console.error('\n❌  readjudicate-fuel failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
