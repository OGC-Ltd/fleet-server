/**
 * Render the report's Fuel drains table from LIVE data, without a browser.
 *
 * Calls the same two functions the endpoint calls — `fuelConsumption` then
 * `priceFuelConsumption` — so what prints here is the payload the dashboard
 * receives, not a reconstruction of it. The formatting below mirrors
 * dash/src/utils/analytics_report.js; that part IS a replica, so a difference
 * in the PDF's own layout would not show up here. What it does prove is that
 * every column has a value to draw.
 */
import { fuelConsumption } from '../src/modules/analytics/analytics.repository.js'
import { priceFuelConsumption } from '../src/modules/analytics/fuel-pricing.js'
import { prisma } from '../src/lib/prisma.js'

const DAYS = 30
const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })

// The report's own helpers, mirrored.
const fmt = (n: number, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const dash = (n: number | null, d = 0) => (n == null ? '—' : fmt(n, d))
const fmtStamp = (iso: Date | null) => {
  if (iso == null) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}
const fmtMins = (s: number | null) => (s == null ? '—' : String(Math.max(1, Math.round(s / 60))))
const fmtCause = (c: string | null, r: string | null) => {
  if (c == null) return '—'
  const s = c.toLowerCase().replace(/_/g, ' ')
  return r ? `${s} (${r.replace(/-/g, ' ')})` : s
}

const MAX = 120

for (const org of orgs) {
  const raw = await fuelConsumption(org.id, { days: DAYS } as never)
  const paid = priceFuelConsumption(raw, {
    pricePerLitre: 179.36, currency: 'KES', source: 'configured',
  })
  const drains = paid.drains
  if (drains.length === 0) { console.log(`\n  ${org.code}: no drains\n`); continue }

  const shown = drains.slice(0, MAX)
  const announced = drains.filter(d => d.announced).length
  const uncaused  = drains.filter(d => d.cause == null).length
  const measured  = shown.filter(d => d.fallSeconds != null).length

  console.log(`\n\n  ══════ ${org.code} ══════`)
  console.log(`  FUEL DRAINS — ${fmt(drains.length)} RECORDED, ${fmt(MAX)} MOST RECENT SHOWN`)
  console.log(`\n  ${[
    `Of ${fmt(drains.length)} recorded, ${fmt(announced)} were announced to an operator.`,
    'A recorded drop is a fall the fuel ledger could not explain from ordinary consumption — it is not a finding of theft.',
    uncaused > 0 ? `${fmt(uncaused)} carry no attributable cause, most often because the unit reports no ignition state.` : null,
    'Drops the adjudicator judged to be fuel returning, or a probe fault, are already excluded.',
    measured === 0
      ? 'Fall duration was measured on none of these; it has only been recorded since 28 Aug 2026.'
      : `Fall duration was measured on ${fmt(measured)} of the ${fmt(shown.length)} shown; it has only been recorded since 28 Aug 2026.`,
  ].filter(Boolean).join(' ')}`)

  const H = ['When (EAT)', 'Unit', 'FSL before (L)', 'FSL after (L)', 'Litres', 'Fall (min)', 'Where', 'Cause']
  const W = [13, 16, 15, 14, 8, 11, 24, 30]
  const line = (cells: string[]) =>
    cells.map((c, i) => (i >= 2 && i <= 5 ? c.padStart(W[i]!) : c.slice(0, W[i]!).padEnd(W[i]!))).join(' ')
  console.log('\n  ' + line(H))
  console.log('  ' + W.map(w => '─'.repeat(w)).join(' '))
  for (const d of shown.slice(0, 12)) {
    console.log('  ' + line([
      fmtStamp(d.beganAt), d.registrationPlate ?? d.name ?? '—',
      dash(d.levelBefore, 1), dash(d.levelAfter, 1), dash(d.litres, 1),
      fmtMins(d.fallSeconds), d.location ?? '—', fmtCause(d.cause, d.causeReason),
    ]))
  }
  console.log(`  ... ${shown.length - 12} more rows on the page`)

  // Every column must have something to draw, and the arithmetic must hold.
  const blank = (k: string, n: number) =>
    console.log(`    ${k.padEnd(16)} ${n === 0 ? 'OK — every row has a value' : `${n} of ${shown.length} blank`}`)
  console.log('\n  column coverage on the rows that will be drawn:')
  blank('when',        shown.filter(d => d.beganAt == null).length)
  blank('unit',        shown.filter(d => (d.registrationPlate ?? d.name) == null).length)
  blank('FSL before',  shown.filter(d => d.levelBefore == null).length)
  blank('FSL after',   shown.filter(d => d.levelAfter == null).length)
  blank('litres',      shown.filter(d => d.litres == null).length)
  blank('fall',        shown.filter(d => d.fallSeconds == null).length)
  blank('where',       shown.filter(d => d.location == null).length)
  blank('cause',       shown.filter(d => d.cause == null).length)

  const bad = shown.filter(d =>
    d.levelBefore != null && d.levelAfter != null &&
    Math.abs((d.levelBefore - d.levelAfter) - d.litres) > 0.15)
  console.log(`\n  before − after === litres : ${bad.length === 0
    ? `holds on all ${shown.length} rows` : `FAILS on ${bad.length}`}`)
  const sum = Math.round(drains.reduce((s, d) => s + d.litres, 0) * 10) / 10
  console.log(`  rows sum to ${fmt(sum, 1)} L · header says ${fmt(paid.totals.litresLost, 1)} L : ` +
    `${Math.abs(sum - paid.totals.litresLost) < 1 ? 'RECONCILES' : 'MISMATCH'}`)
}

process.exit(0)
