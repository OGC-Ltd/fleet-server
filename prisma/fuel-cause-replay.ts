/**
 * Replay `classifyDrain` over the measured drains dumped by
 * `fuel-cause-measure.ts --dump`, with no database at all.
 *
 * The measurement pass costs ~45 minutes against a 1 GB RDS. This reads its
 * output file, so any question about a threshold — what does 3x fire, what
 * happens if the siphon floor moves — is answered in under a second and can be
 * asked as many times as it takes to settle on a number.
 *
 * It runs the REAL classifier, not a restatement of it, so what this prints is
 * what the live pass would decide given the same evidence.
 *
 * Usage:
 *   npx tsx prisma/fuel-cause-replay.ts <drains.json> [--multiple 4] [--days 30]
 */

import { readFileSync } from 'node:fs'
import {
  classifyDrain, resolveBand, isAnnounced, mayUseTheftWording,
  type DropEvidence, type DrainCause,
} from '../src/modules/fuel/fuel-theft-classifier.js'
import type { ProbeProfile } from '../src/modules/fuel/fuel-adjudication.js'

interface MeasuredRow {
  id: string; plate: string; org: string; reason: string
  claimedMl: number; dropMl: number; fallSec: number; engineSec: number
  evidence: number; moved: boolean
  impliedLph: number | null; expectedLph: number | null; wallLph: number
  kT: number | null; halfSlope: number | null; stepFraction: number
  linRmse: number | null; decRmse: number | null; samples: number
  distanceKm: number | null; kmPerL: number | null
}

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt
}
const DAYS = Number(arg('days', '30'))
const path = process.argv[2]
if (!path || path.startsWith('--')) throw new Error('usage: fuel-cause-replay.ts <drains.json> [--days 30]')

const rows: MeasuredRow[] = JSON.parse(readFileSync(path, 'utf8'))

/**
 * The probe trust gate is applied UPSTREAM of the classifier by
 * `judgeDrain`, and the profile it uses is not in the dump. The measurement
 * carries the adjudication reason instead, and `probe-swings` is precisely the
 * rows that gate already caught — so they are replayed as a swinging profile,
 * which is what the live pass would hand the classifier.
 */
const profileFor = (r: MeasuredRow): ProbeProfile | null =>
  r.reason === 'probe-swings' ? { parkedWindows: 40, swingWindows: 20 } : { parkedWindows: 40, swingWindows: 0 }

const evidenceOf = (r: MeasuredRow): DropEvidence => ({
  dropMl:         r.dropMl,
  fallSeconds:    r.fallSec,
  engineSeconds:  r.engineSec,
  engineEvidence: r.evidence,
  moved:          r.moved,
  stepFraction:   r.stepFraction,
  kT:             r.kT,
  // The classifier wants the residual as a SHARE of the drop — a raw
  // millilitre figure means nothing without the fall it belongs to.
  decayResidual:  r.decRmse != null && r.dropMl > 0 ? r.decRmse / r.dropMl : null,
  samples:        r.samples,
  // Older dumps predate this field. Undefined silently disables the road
  // branch — which it did, and quietly, because prisma/*.ts sits outside
  // tsconfig's include and is never typechecked.
  distanceKm:     r.distanceKm ?? null,
})

const pad  = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
const padL = (s: string, n: number): string => s.length >= n ? s : ' '.repeat(n - s.length) + s

const counts = new Map<DrainCause, number>()
const announced: Array<{ r: MeasuredRow; cause: DrainCause; conf: number }> = []

for (const r of rows) {
  // The band resolves exactly as it will live: operator table first (empty
  // today), then the derived rate widened into a band.
  const band = resolveBand(r.org, r.plate, r.expectedLph != null
    ? { lPerHour: r.expectedLph, basis: 'type', lPerKm: r.kmPerL != null ? 1 / r.kmPerL : null }
    : null)
  const j = classifyDrain(evidenceOf(r), band, profileFor(r))
  counts.set(j.cause, (counts.get(j.cause) ?? 0) + 1)
  if (isAnnounced(j.cause)) announced.push({ r, cause: j.cause, conf: j.confidence })
}

console.log(`\nreplayed ${rows.length} measured drains over ${DAYS} days\n`)
console.log('  cause                      n      share    per day')
console.log('  ' + '─'.repeat(52))
for (const [cause, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(cause, 20)} ${padL(String(n), 6)} ${padL(((n / rows.length) * 100).toFixed(1) + '%', 9)} ${padL((n / DAYS).toFixed(2), 10)}`)
}

console.log(`\n  ANNOUNCED total: ${announced.length}  →  ${(announced.length / DAYS).toFixed(1)} per day`)
console.log(`  today every DRAIN notifies: ${rows.length}  →  ${(rows.length / DAYS).toFixed(1)} per day`)
console.log(`  reduction: ${(100 - (announced.length / rows.length) * 100).toFixed(1)}%`)

const siphons = announced.filter(a => a.cause === 'SIPHON')
console.log(`\n  of those, may be worded "possible theft" (SIPHON): ${siphons.length}  →  ${(siphons.length / DAYS).toFixed(2)} per day`)
console.log(`  the rest are UNEXPLAINED_BURN and must not be: ${announced.length - siphons.length}`)

console.log('\n  the fifteen largest announcements:')
console.log('  plate              cause              drop L   impl L/h  exp L/h  conf  wording')
console.log('  ' + '─'.repeat(88))
for (const a of [...announced].sort((x, y) => y.r.dropMl - x.r.dropMl).slice(0, 15)) {
  console.log(
    `  ${pad(a.r.plate, 18)} ${pad(a.cause, 18)} ${padL((a.r.dropMl / 1000).toFixed(1), 7)}` +
    ` ${padL(a.r.impliedLph != null ? a.r.impliedLph.toFixed(1) : '—', 10)}` +
    ` ${padL(a.r.expectedLph != null ? a.r.expectedLph.toFixed(1) : '—', 8)}` +
    ` ${padL(a.conf.toFixed(2), 5)}  ${mayUseTheftWording(a.cause) ? 'possible theft' : 'unexplained'}`,
  )
}

// How concentrated is this? An alert stream dominated by five machines is a
// maintenance list, not a theft investigation, and the operator should know
// which of the two they are being handed.
const byPlate = new Map<string, number>()
for (const a of announced) byPlate.set(a.r.plate, (byPlate.get(a.r.plate) ?? 0) + 1)
const top = [...byPlate.entries()].sort((a, b) => b[1] - a[1])
console.log(`\n  ${byPlate.size} distinct vehicles produce the ${announced.length} announcements`)
console.log('  worst offenders:')
for (const [plate, n] of top.slice(0, 10)) {
  console.log(`    ${pad(plate, 20)} ${padL(String(n), 4)}  ${((n / announced.length) * 100).toFixed(1)}% of all alerts`)
}
console.log('')
