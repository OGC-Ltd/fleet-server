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
 *
 * --causes also rewrites the CAUSE, the figures and the measured evidence
 * (judgementData, the live sweep's own write) wherever any of them would
 * change, not the verdict alone. Still never notifies. Used 2026-10-30 to bring
 * drains judged since 29 Oct onto the clean figures and the widened
 * standing-theft rule:
 *
 *   npx tsx prisma/readjudicate-fuel.ts --since 2026-10-29T00:00:00+03:00 --causes
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { isConfirmed, isUncheckable, OBSERVED_DROP_MIN_RATIO, RECOVERY_THRESHOLD } from '../src/modules/fuel/fuel-adjudication.js'
import { judgeDrain, judgementData } from '../src/modules/fuel/fuel-adjudication.service.js'
import { announces } from '../src/modules/fuel/fuel-theft-classifier.js'

const argv  = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag  = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null
}
const ONLY_ORG = flag('org')?.toUpperCase() ?? null
const DAYS     = Number(flag('days') ?? 30)
const LIMIT    = Number(flag('limit') ?? 5000)
const SINCE    = flag('since')
const CAUSES   = argv.includes('--causes')

const L = (ml: number) => `${(ml / 1000).toFixed(1)} L`

async function main() {
  const since = SINCE ? new Date(SINCE) : new Date(Date.now() - DAYS * 24 * 3600_000)
  if (Number.isNaN(since.getTime())) throw new Error(`--since: not a date: ${SINCE}`)
  if (CAUSES) console.log('    --causes: cause, figures and evidence are rewritten too')
  console.log(`\n⛽  re-judging drains already given a verdict  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
  console.log(`    window since ${since.toISOString().slice(0, 16).replace('T', ' ')} UTC · recovery ${(RECOVERY_THRESHOLD * 100).toFixed(0)}% · observed drop ≥ ${(OBSERVED_DROP_MIN_RATIO * 100).toFixed(0)}% of claim\n`)

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
        drainCause: true, causeReason: true, measuredDropMl: true, cleanDropMl: true,
        vehicle: { select: { registrationPlate: true } },
      },
      orderBy: { beganAt: 'desc' },
      take: LIMIT,
    })
    if (rows.length === 0) continue

    const changes: string[] = []
    const matrix: Record<string, number> = {}
    // The CAUSE is a separate judgement layered on the verdict, and a rule change
    // can move it without touching the verdict at all — which the verdict matrix
    // below cannot show, because it skips rows whose verdict is unchanged. Kept
    // in its own matrix so the two questions stay separable.
    const causeMatrix: Record<string, number> = {}
    let announcedBefore = 0, announcedAfter = 0
    let mlBackIntoLoss = 0, mlWrittenOff = 0, kept = 0, examined = 0

    // Progress. This pass is round-trip bound -- one telemetry window per drain
    // -- so a 30-day run is hours, and until now it printed nothing at all until
    // the end. A run you cannot see the inside of is a run you cannot decide to
    // abandon, which is exactly what happened on 2026-08-26.
    const startedAt = Date.now()

    for (const t of rows) {
      grandExamined++; examined++
      if (examined % 100 === 0) {
        const rate = examined / Math.max(1, (Date.now() - startedAt) / 1000)
        console.log(`    ...${examined}/${rows.length} judged, ${rate.toFixed(1)}/s`)
      }

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

      // Cause, counted for EVERY examined row — including the ones the verdict
      // matrix is about to skip. `judgeDrain` returns a null cause whenever the
      // verdict is not DRAIN, so "—" here means "no cause was owed", not "no
      // cause was found". Announceability is counted off the same pair, since
      // that is the only number an operator actually experiences.
      const causeOf = (c: string | null, r: string | null) =>
        c == null ? '—' : `${c}${r ? `/${r}` : ''}`
      const cFrom = causeOf(t.drainCause, t.causeReason)
      const cTo   = causeOf(next.cause?.cause ?? null, next.cause?.reason ?? null)
      causeMatrix[`${cFrom} → ${cTo}`] = (causeMatrix[`${cFrom} → ${cTo}`] ?? 0) + 1
      if (t.drainCause != null && announces({ cause: t.drainCause, reason: t.causeReason ?? '' })) announcedBefore++
      if (next.cause != null && announces(next.cause)) announcedAfter++

      // The stated figure: the clean one where the row has it, else the fall.
      if (CAUSES) {
        const figure = (ml: number | null) => ml == null ? '—' : L(ml)
        const before = t.cleanDropMl ?? t.measuredDropMl
        const after  = next.lossMl ?? next.evidence?.dropMl ?? null
        if (from === to && cFrom === cTo && before === after) continue
        changes.push(
          `     ${t.vehicle.registrationPlate.padEnd(16)} ${t.beganAt.toISOString().slice(0, 16).replace('T', ' ')}  ` +
          `${cFrom === cTo ? cFrom : `${cFrom} → ${cTo}`}  ${figure(before)} → ${figure(after)}` +
          (from === to ? '' : `  [${from} → ${to}]`),
        )
        grandChanged++
        if (APPLY) await prisma.fuelTheft.update({ where: { id: t.id }, data: judgementData(next, now) })
        continue
      }

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

    const causeMoved = Object.entries(causeMatrix)
      .filter(([k]) => k.split(' → ')[0] !== k.split(' → ')[1])
      .sort((a, b) => b[1] - a[1])
    console.log(`\n     cause — ${causeMoved.reduce((s, [, n]) => s + n, 0)} of ${examined} move`)
    for (const [k, n] of causeMoved) console.log(`     ${String(n).padStart(4)}  ${k}`)
    console.log(`     announceable: ${announcedBefore} → ${announcedAfter}` +
                ` (${announcedAfter - announcedBefore >= 0 ? '+' : ''}${announcedAfter - announcedBefore})`)
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
