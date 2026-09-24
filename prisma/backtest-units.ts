/**
 * Re-judge a named set of units under the CURRENT code, and report what an
 * operator would actually be told.
 *
 * READ-ONLY. It writes nothing — it calls the same `judgeDrain` and
 * `judgeFilling` the live sweep calls and throws the answers away.
 *
 * This is a true backtest rather than a replay: `measure-alerting-gates.ts`
 * reconstructs the parked branch from stored evidence columns, which cannot
 * cover rows with no persisted fall shape, the filling baseline change, or
 * `peakIntervalLph` (absent on every row judged before 2026-09-24). This runs
 * the real functions over real telemetry, so every change on the branch is in
 * scope at once.
 *
 * ## The four questions asked of the result
 *
 *   CONFIRMED THEFT     a drain whose cause is SIPHON — the only cause
 *                       `mayUseTheftWording` admits and the only member of
 *                       ANNOUNCED. This is what reaches an operator.
 *   SUSPICIOUS DRAIN    fuel left the tank and we cannot say it was taken:
 *                       verdict DRAIN with a cause outside CAUSE_NO_FUEL_LEFT.
 *                       Counted as loss, not announced.
 *   REFILL              a delivery our own telemetry watched arrive. Counts as
 *                       fuel IN, and does not excuse any drain: a drain is
 *                       judged on whether the level stayed down UNTIL the fill.
 *   CANCELS THE DRAIN   the level came back, so nothing left — verdict
 *                       REDISTRIBUTION, or a cause in CAUSE_NO_FUEL_LEFT
 *                       (SLOSH, SETTLING). Excluded from the loss figures.
 *
 *   npx tsx prisma/backtest-units.ts --days=14 --tunnel
 */

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma.js'
import { judgeDrain } from '../src/modules/fuel/fuel-adjudication.service.js'
import { judgeFilling } from '../src/modules/fuel/fuel-filling-adjudication.service.js'
import { NO_FUEL_LEFT } from '../src/modules/fuel/fuel-adjudication.js'
import { CAUSE_NO_FUEL_LEFT, announces, mayUseTheftWording } from '../src/modules/fuel/fuel-theft-classifier.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const DAYS = Number(arg('days') ?? 14)
/** Restrict to one EAT calendar day, e.g. --on=2026-09-23. */
const ON = arg('on')
/** Restrict to a named subset, e.g. --units="FT 13,MTR 09". */
const ONLY = arg('units')?.split(',').map(s => s.trim()).filter(Boolean)
/** Every vehicle in the org, not just the named list. */
const ALL = process.argv.includes('--all')

/**
 * The units under test: the 61-line list supplied for the sensor audit, plus
 * the three named individually afterwards while the fuel cases were being
 * worked through. They are not in the file because the file is the sensor
 * list; they belong here because the question is about fuel.
 */
const EXTRA = ['MUFINDI: MTR 04', 'MUFINDI: MTR 20', 'MUFINDI: CTR 19']

const key = (n: string): string =>
  n.trim().toUpperCase().replace(/^MUFINDI\s*[-:]?\s*/, '').replace(/\s+/g, ' ').trim()

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
const L = (ml: number | null | undefined): string =>
  ml == null ? '—' : `${(ml / 1000).toFixed(1)} L`

async function main() {
  const file = new URL('./accel-units.txt', import.meta.url).pathname
  const names = [
    ...readFileSync(file, 'utf8').split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#')),
    ...EXTRA,
  ]
  const wanted = new Set(names.map(key))

  const vehicles = await prisma.vehicle.findMany({
    where:  { organisation: { code: 'KASULU' } },
    select: { id: true, name: true },
  })
  const only = ONLY ? new Set(ONLY.map(key)) : null
  const under = ALL ? vehicles : vehicles.filter(v => (only ?? wanted).has(key(v.name)))

  // The operator reads EAT (UTC+3); the column stores UTC. A "day" is therefore
  // 21:00 the previous evening to 21:00 on the day itself.
  const since = ON ? new Date(`${ON}T00:00:00+03:00`)
                   : new Date(Date.now() - DAYS * 86_400_000)
  const until = ON ? new Date(`${ON}T23:59:59+03:00`) : new Date(8.64e15)
  // Judge as though it were now, so nothing is held back as still settling.
  const now = new Date()

  // `under.length` can EXCEED `wanted.size`: this account carries pairs like
  // "MUFINDI - EX 04" and "MUFINDI: EX 04" as separate vehicles, and the
  // matcher strips the separator, so one name can resolve to two rows.
  const matched = new Set(under.map(v => key(v.name)))
  console.log(`\n  BACKTEST — current code · ${ON ? `${ON} (EAT day)` : `${DAYS} days`}`)
  if (ALL) {
    console.log(`  every KASULU vehicle — ${under.length} rows`)
  } else {
    const askedFor = only ?? wanted
    console.log(`  ${matched.size} of ${askedFor.size} names matched, across ${under.length} vehicle rows`)
    for (const k of askedFor) if (!matched.has(k)) console.log(`    NOT FOUND: ${k}`)
  }
  console.log(`  ${'═'.repeat(76)}`)

  const drains = await prisma.fuelTheft.findMany({
    where:  { vehicleId: { in: under.map(v => v.id) }, detectedAt: { gte: since, lte: until } },
    select: { id: true, vehicleId: true, beganAt: true, detectedAt: true, stolenMl: true,
              verdict: true, drainCause: true },
    orderBy: { detectedAt: 'asc' },
  })
  const fillings = await prisma.fuelFilling.findMany({
    where:  { vehicleId: { in: under.map(v => v.id) }, filledAt: { gte: since, lte: until } },
    select: { id: true, vehicleId: true, filledAt: true, filledMl: true, verdict: true },
    orderBy: { filledAt: 'asc' },
  })
  const nameOf = new Map(under.map(v => [v.id, v.name]))
  console.log(`  ${drains.length} drains · ${fillings.length} fillings to re-judge\n`)

  type Row = { vehicle: string; when: Date; ml: number; before: string; after: string
               detail: string; announced: boolean }
  const theft: Row[] = [], suspicious: Row[] = [], cancels: Row[] = [], unjudgeable: Row[] = []

  for (const [i, d] of drains.entries()) {
    if (i % 25 === 0 && i > 0) process.stdout.write(`    …${i}/${drains.length}\r`)
    const out = await judgeDrain(
      { vehicleId: d.vehicleId, beganAt: d.beganAt, detectedAt: d.detectedAt, stolenMl: d.stolenMl }, now)
    const row: Row = {
      vehicle: nameOf.get(d.vehicleId) ?? d.vehicleId,
      when: d.detectedAt, ml: d.stolenMl,
      before: `${d.verdict}/${d.drainCause ?? '—'}`,
      after:  `${out.verdict}/${out.cause?.cause ?? '—'}`,
      detail: out.cause?.reason ?? out.reason,
      // What actually reaches an operator is `announces`, not the cause alone:
      // since 2026-08-17 a burn finding on an operator-set ceiling announces
      // while the same cause on a derived band does not.
      announced: out.cause ? announces(out.cause) : false,
    }
    const cause = out.cause?.cause
    if (out.verdict === 'PENDING') unjudgeable.push(row)
    else if (cause === 'SIPHON') theft.push(row)
    else if (NO_FUEL_LEFT.includes(out.verdict as never)) cancels.push(row)
    else if (cause && CAUSE_NO_FUEL_LEFT.includes(cause)) cancels.push(row)
    else suspicious.push(row)
  }

  const refills: Row[] = [], phantom: Row[] = []
  for (const f of fillings) {
    const out = await judgeFilling(
      { vehicleId: f.vehicleId, filledAt: f.filledAt, filledMl: f.filledMl }, now)
    const row: Row = {
      vehicle: nameOf.get(f.vehicleId) ?? f.vehicleId,
      when: f.filledAt, ml: f.filledMl,
      before: f.verdict, after: out.verdict, detail: out.reason, announced: false,
    }
    if (out.verdict === 'REFILL') refills.push(row); else phantom.push(row)
  }

  const sum = (rs: Row[]) => rs.reduce((s, r) => s + r.ml, 0)
  const show = (title: string, rs: Row[], note: string) => {
    console.log(`\n  ${title} — ${rs.length}  ·  ${L(sum(rs))}`)
    console.log(`    ${note}`)
    const moved = rs.filter(r => r.before !== r.after)
    if (moved.length) console.log(`    ${moved.length} of these CHANGED verdict under the new logic:`)
    for (const r of moved.slice(0, 12)) {
      console.log(`      ${pad(r.vehicle, 22)}${pad(r.when.toISOString().slice(5, 16).replace('T', ' '), 13)}` +
                  `${pad(L(r.ml), 9)}${pad(r.before, 26)} -> ${r.after}  ${r.detail}`)
    }
    if (moved.length > 12) console.log(`      …and ${moved.length - 12} more`)
  }

  show('CONFIRMED THEFT (SIPHON — reaches an operator)', theft,
       'Announced, and the only verdict that may use the word theft.')
  show('SUSPICIOUS DRAIN (fuel left, cause not established)', suspicious,
       'Counted as loss. Not announced — the cause gate keeps it off the feed.')
  show('CANCELS THE DRAIN (nothing left the tank)', cancels,
       'REDISTRIBUTION, SLOSH or SETTLING — excluded from the loss figures.')
  show('REFILL (a delivery we watched arrive)', refills,
       'Counts as fuel IN. Does not excuse a drain: a drain is judged on whether')
  show('PHANTOM FILLING (claimed, never arrived)', phantom,
       'REDISTRIBUTION on the filling ledger — excluded from fuel in.')
  if (unjudgeable.length) show('STILL UNJUDGEABLE', unjudgeable, 'No verdict reachable from the telemetry that survives.')

  console.log(`\n  ${'═'.repeat(76)}`)
  console.log(`  SUMMARY over ${DAYS} days`)
  console.log(`    confirmed theft (announced)    ${pad(String(theft.length), 6)}${L(sum(theft))}`)
  console.log(`    suspicious drain (counted)     ${pad(String(suspicious.length), 6)}${L(sum(suspicious))}`)
  console.log(`    cancels the drain              ${pad(String(cancels.length), 6)}${L(sum(cancels))}`)
  console.log(`    real refills (fuel in)         ${pad(String(refills.length), 6)}${L(sum(refills))}`)
  console.log(`    phantom fillings               ${pad(String(phantom.length), 6)}${L(sum(phantom))}`)
  console.log(`\n    net counted as fuel that left  ${L(sum(theft) + sum(suspicious))}`)

  // The number the operator actually pays for. SIPHON is the only cause that
  // may be WORDED as theft, but it is not the only thing that reaches the feed.
  const all = [...theft, ...suspicious, ...cancels]
  const loud = all.filter(r => r.announced)
  console.log(`\n  ${'═'.repeat(76)}`)
  console.log(`  WHAT REACHES AN OPERATOR — ${loud.length} items over ${DAYS} days ` +
              `(${(loud.length / DAYS).toFixed(1)}/day) · ${L(sum(loud))}`)
  const byReason = new Map<string, number>()
  for (const r of loud) byReason.set(r.detail, (byReason.get(r.detail) ?? 0) + 1)
  for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(k, 28)} ${n}${k === 'parked-sustained-fall' ? '   (may be worded as theft)' : ''}`)
  }
  const newlyLoud = loud.filter(r => r.before !== r.after)
  console.log(`\n  of which ${newlyLoud.length} are NEW — silent under the old code:`)
  for (const r of newlyLoud.slice(0, 15)) {
    console.log(`    ${pad(r.vehicle, 22)}${pad(r.when.toISOString().slice(5, 16).replace('T', ' '), 13)}` +
                `${pad(L(r.ml), 9)}${pad(r.before, 24)} -> ${r.detail}`)
  }
  console.log('')
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
