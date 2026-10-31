/**
 * Export drains for a human to adjudicate, as a spreadsheet.
 *
 * READ-ONLY against the database.
 *
 * ## Why this exists
 *
 * Every threshold in the classifier is currently an ALERT-VOLUME choice rather
 * than an accuracy one, because nothing says which flagged events were real.
 * Measured over 30 days, median excess sits flat at 29-31 L from 1.5x to 50x —
 * so no value on that axis buys better targeting, and picking one is picking how
 * many alerts a day an operator receives. The same gap blocks two further
 * decisions: whether the measured tank balance should outrank the derived rate
 * in `resolveBand`, and whether the 16 SUKARI announcements the
 * consumption-basis change retired were true or false.
 *
 * Twenty to thirty adjudicated events is enough to state precision for the first
 * time. That is operator time, not engineering time, which is why this ships as
 * a spreadsheet rather than a screen.
 *
 * ## What it selects, and why not simply the biggest
 *
 * Sorting by litres would hand back thirty events from the four machines that
 * dominate the ledger, and precision measured on those describes those machines
 * rather than the detector. The sample is STRATIFIED by cause instead: up to
 * `--per-cause` from each, newest first, so every rule the classifier can reach
 * gets examined. A cause that never appears in the sample can never be scored.
 *
 * Announced events are marked, because those are the ones an operator actually
 * saw; the unannounced ones are how false NEGATIVES get found, which is the half
 * a review of the alert feed alone can never reach.
 *
 * ## The columns
 *
 * Everything a reviewer needs to decide without opening the system, and nothing
 * derived that they would have to take on trust. Where a figure is missing it is
 * blank rather than zero — most of the evidence columns are null on rows judged
 * before 2026-08-28, which is worth seeing rather than papering over.
 *
 *     npx cross-env DOTENV_CONFIG_PATH=.env tsx prisma/export-fuel-labels.ts
 *     ...                                        --days 30 --per-cause 6 --out review.xlsx
 */

import { prisma } from '../src/lib/prisma.js'
import { announces } from '../src/modules/fuel/fuel-theft-classifier.js'
import * as XLSX from 'xlsx'

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt
}
const DAYS      = Number(arg('days', '30'))
const PER_CAUSE = Number(arg('per-cause', '6'))
const OUT       = arg('out', `fuel-review-${new Date().toISOString().slice(0, 10)}.xlsx`)
const ONLY_ORG  = arg('org', '')

const since = new Date(Date.now() - DAYS * 86_400_000)

const rows = await prisma.fuelTheft.findMany({
  where: {
    beganAt: { gte: since },
    verdict: 'DRAIN',
    ...(ONLY_ORG ? { vehicle: { organisation: { code: ONLY_ORG.toUpperCase() } } } : {}),
  },
  select: {
    id: true, beganAt: true, detectedAt: true, stolenMl: true,
    initialFuelLevelMl: true, finalFuelLevelMl: true, initialLocation: true,
    verdict: true, verdictReason: true, verdictConfidence: true,
    drainCause: true, causeReason: true, causeConfidence: true,
    fallSeconds: true, measuredDropMl: true, engineSeconds: true,
    engineEvidence: true, stepFraction: true, impliedLph: true, fallDistanceKm: true,
    vehicle: {
      select: {
        registrationPlate: true, vehicleType: true, tankCapacityLitres: true,
        organisation: { select: { code: true } },
      },
    },
  },
  orderBy: { beganAt: 'desc' },
})

// Stratify: up to PER_CAUSE per cause, newest first. `rows` is already newest
// first, so taking the first N of each group needs no further sorting.
const byCause = new Map<string, typeof rows>()
for (const r of rows) {
  const key = `${r.drainCause ?? 'NONE'}/${r.causeReason ?? '—'}`
  const list = byCause.get(key) ?? []
  if (list.length < PER_CAUSE) { list.push(r); byCause.set(key, list) }
}
const sample = [...byCause.values()].flat()
  .sort((a, b) => b.beganAt.getTime() - a.beganAt.getTime())

const L  = (ml: number | null) => (ml == null ? '' : Math.round(ml / 100) / 10)
const r1 = (n: number | null) => (n == null ? '' : Math.round(n * 10) / 10)
const r2 = (n: number | null) => (n == null ? '' : Math.round(n * 100) / 100)

const sheet = sample.map(r => ({
  'event id':        r.id,
  'org':             r.vehicle.organisation?.code ?? '',
  'plate':           r.vehicle.registrationPlate,
  'type':            r.vehicle.vehicleType ?? '',
  'tank L':          r.vehicle.tankCapacityLitres ?? '',
  'began (EAT)':     new Date(r.beganAt.getTime() + 3 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16),
  'where':           r.initialLocation ?? '',
  'claimed L':       L(r.stolenMl),
  'measured L':      L(r.measuredDropMl),
  'tank before L':   L(r.initialFuelLevelMl),
  'tank after L':    L(r.finalFuelLevelMl),
  'fall min':        r.fallSeconds == null ? '' : Math.max(1, Math.round(r.fallSeconds / 60)),
  'engine min':      r.engineSeconds == null ? '' : Math.round(r.engineSeconds / 60),
  'ignition measured %': r.engineEvidence == null ? '' : Math.round(r.engineEvidence * 100),
  'biggest step %':  r.stepFraction == null ? '' : Math.round(r.stepFraction * 100),
  'implied L/h':     r1(r.impliedLph),
  'km in fall':      r2(r.fallDistanceKm),
  'verdict':         r.verdict,
  'verdict reason':  r.verdictReason ?? '',
  'cause':           r.drainCause ?? '',
  'cause reason':    r.causeReason ?? '',
  'confidence':      r2(r.causeConfidence),
  'announced':       r.drainCause != null && announces({ cause: r.drainCause, reason: r.causeReason ?? '' }) ? 'YES' : '',
  // The two the reviewer fills in. Left empty on purpose — a pre-filled guess
  // is what a tired reviewer confirms.
  'LABEL (THEFT / NOT_THEFT / UNSURE)': '',
  'NOTE': '',
  'YOUR NAME': '',
}))

const wb = XLSX.utils.book_new()
const ws = XLSX.utils.json_to_sheet(sheet)
// Wide enough to read without dragging every column.
ws['!cols'] = Object.keys(sheet[0] ?? {}).map(k => ({ wch: Math.max(10, Math.min(34, k.length + 4)) }))
XLSX.utils.book_append_sheet(wb, ws, 'review')
XLSX.writeFile(wb, OUT)

console.log(`\n  ${sample.length} drains written to ${OUT}`)
console.log(`  drawn from ${rows.length} DRAIN rows over ${DAYS} days` +
            `${ONLY_ORG ? ` · ${ONLY_ORG.toUpperCase()} only` : ''}\n`)
console.log('  cause / reason                                   in sample   available')
for (const [key, list] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
  const available = rows.filter(r => `${r.drainCause ?? 'NONE'}/${r.causeReason ?? '—'}` === key).length
  console.log(`  ${key.padEnd(48)}${String(list.length).padStart(9)}${String(available).padStart(12)}`)
}
// Counted off `sheet`, not `sample`: the announced flag is computed during the
// mapping, and `sample` holds the raw rows with no such key. Reading it there
// silently yielded undefined for every row and reported a confident zero.
const announced = sheet.filter(s => s['announced'] === 'YES').length
console.log(`\n  ${announced} of ${sheet.length} were announced to an operator.`)
console.log(`  The rest are how FALSE NEGATIVES get found — reviewing only the`)
console.log(`  alert feed can never reach them.\n`)

process.exit(0)
