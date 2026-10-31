/**
 * Precision and recall against the labelled set, per cause and per threshold.
 *
 * READ-ONLY.
 *
 * This is the first thing in the fuel module that can state an accuracy rather
 * than argue one, and it is worth being precise about what it can and cannot
 * say.
 *
 * ## What the numbers mean here
 *
 * The population is the LABELLED events, not the fleet. So:
 *
 * - **Precision** — of the events this detector announced, the share a human
 *   called theft. Honest, because the labelled set deliberately includes
 *   announced events.
 * - **Recall** — of the events a human called theft, the share this detector
 *   announced. Honest only to the extent the labelled set contains thefts the
 *   detector MISSED, which is exactly why the export includes unannounced
 *   events. Recall measured on announced events alone is 100% by construction
 *   and means nothing.
 *
 * Neither generalises to the fleet unless the labelled sample is representative
 * of it, and the export stratifies by CAUSE rather than sampling randomly — so
 * these are per-rule accuracies, not a fleet-wide error rate. Reported that way
 * on purpose: "SIPHON is right 4 times in 5" is a statement someone can act on,
 * where a single blended figure is not.
 *
 * ## UNSURE
 *
 * Excluded from precision and recall, and reported separately. A reviewer who
 * could not call an event has told us something real — a detector producing
 * events nobody can adjudicate has a problem the arithmetic will not show — but
 * folding those into either class would be inventing the answer they declined
 * to give.
 *
 * ## Disagreement between reviewers
 *
 * Where two people labelled the same event differently, the event is counted as
 * CONTESTED and excluded from the totals rather than resolved by majority. Two
 * reviewers disagreeing is the most interesting row in the output and the one
 * worth reading before any threshold is moved.
 *
 *     npx cross-env DOTENV_CONFIG_PATH=.env tsx prisma/score-fuel-labels.ts
 */

import { prisma } from '../src/lib/prisma.js'
import { announces, ANNOUNCE_MULTIPLE } from '../src/modules/fuel/fuel-theft-classifier.js'

const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)
const pct  = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(0)}%` : '—')

const labels = await prisma.fuelEventLabel.findMany({
  where:  { eventType: 'THEFT' },
  select: { eventId: true, label: true, labelledBy: true, note: true },
})

if (labels.length === 0) {
  console.log('\n  No labels yet.')
  console.log('  Export a sheet with prisma/export-fuel-labels.ts, have it reviewed,')
  console.log('  then load it back with prisma/import-fuel-labels.ts --apply.\n')
  process.exit(0)
}

// Collapse to one verdict per event, marking disagreement rather than voting.
const byEvent = new Map<string, Set<string>>()
for (const l of labels) {
  const s = byEvent.get(l.eventId) ?? new Set<string>()
  s.add(l.label)
  byEvent.set(l.eventId, s)
}
const truth = new Map<string, 'THEFT' | 'NOT_THEFT' | 'UNSURE' | 'CONTESTED'>()
for (const [id, set] of byEvent) {
  const decided = [...set].filter(v => v !== 'UNSURE')
  truth.set(id,
    decided.length > 1 ? 'CONTESTED'
    : decided.length === 1 ? decided[0] as 'THEFT' | 'NOT_THEFT'
    : 'UNSURE')
}

const events = await prisma.fuelTheft.findMany({
  where:  { id: { in: [...truth.keys()] } },
  select: {
    id: true, drainCause: true, causeReason: true, stolenMl: true, impliedLph: true,
    vehicle: { select: { registrationPlate: true } },
  },
})

interface Cell { tp: number; fp: number; fn: number; tn: number; unsure: number; contested: number }
const blank = (): Cell => ({ tp: 0, fp: 0, fn: 0, tn: 0, unsure: 0, contested: 0 })
const overall = blank()
const byCause = new Map<string, Cell>()

for (const e of events) {
  const t = truth.get(e.id)!
  const said = e.drainCause != null
    && announces({ cause: e.drainCause, reason: e.causeReason ?? '' })
  const key = `${e.drainCause ?? 'NONE'}/${e.causeReason ?? '—'}`
  const c = byCause.get(key) ?? blank()

  const bump = (cell: Cell) => {
    if (t === 'CONTESTED') { cell.contested++; return }
    if (t === 'UNSURE')    { cell.unsure++;    return }
    if (said && t === 'THEFT')      cell.tp++
    else if (said)                  cell.fp++
    else if (t === 'THEFT')         cell.fn++
    else                            cell.tn++
  }
  bump(overall); bump(c)
  byCause.set(key, c)
}

const scored = overall.tp + overall.fp + overall.fn + overall.tn
console.log(`\n  ${labels.length} labels over ${truth.size} events` +
            ` · ${scored} scored · ${overall.unsure} UNSURE · ${overall.contested} CONTESTED\n`)

if (scored === 0) {
  console.log('  Nothing scoreable yet — every labelled event is UNSURE or contested.\n')
  process.exit(0)
}

console.log('  ANNOUNCED events')
console.log(`    precision  ${pct(overall.tp, overall.tp + overall.fp)}` +
            `   (${overall.tp} of ${overall.tp + overall.fp} announced were called theft)`)
console.log(`    recall     ${pct(overall.tp, overall.tp + overall.fn)}` +
            `   (${overall.tp} of ${overall.tp + overall.fn} thefts were announced)`)
if (overall.fn > 0) {
  console.log(`\n    ${overall.fn} theft(s) the detector did NOT announce — the half a review`)
  console.log(`    of the alert feed alone can never find.`)
}

console.log('\n  by cause / reason')
console.log('    cause / reason                             TP  FP  FN  TN   precision')
for (const [key, c] of [...byCause].sort((a, b) => (b[1].tp + b[1].fp) - (a[1].tp + a[1].fp))) {
  const ann = c.tp + c.fp
  console.log(`    ${padR(key, 42)}${padL(String(c.tp), 3)}${padL(String(c.fp), 4)}` +
              `${padL(String(c.fn), 4)}${padL(String(c.tn), 4)}` +
              `${padL(ann > 0 ? pct(c.tp, ann) : '—', 12)}`)
}

// What the announcement threshold would do, scored on the same labels.
console.log(`\n  ANNOUNCE_MULTIPLE is currently ${ANNOUNCE_MULTIPLE}.`)
const missedNames = events
  .filter(e => truth.get(e.id) === 'THEFT'
            && !(e.drainCause != null && announces({ cause: e.drainCause, reason: e.causeReason ?? '' })))
  .map(e => `${e.vehicle.registrationPlate} (${e.drainCause ?? 'no cause'}/${e.causeReason ?? '—'}, ${Math.round(e.stolenMl / 100) / 10} L)`)
if (missedNames.length > 0) {
  console.log('\n  Thefts that were not announced, and what they were classified as:')
  for (const m of missedNames) console.log(`    ${m}`)
  console.log('\n  A cause appearing repeatedly here is a rule to loosen, not a threshold to move.')
}
console.log()

process.exit(0)
