/**
 * What would change if the MEASURED burn rate outranked the derived one?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The proposal
 *
 * `resolveBand` today asks two questions: does the operator's own class table
 * name this machine, and failing that, what did the run-based derivation
 * produce. Stage 3.6 proposes a third source between them —
 *
 *     operator CLASS_BAND -> measured (>= MIN_DAYS) -> derived own -> type median
 *
 * — on the argument that `fuel-burn-rate.service` is the better measurement: it
 * closes `burn = (opening - closing) + refills - drains` over 30 fleet-days,
 * where the derivation reads engine-on runs over 7 and must discard every run
 * containing a refill. A generator refuelled daily loses nearly all of them.
 *
 * ## What has to be true for that to be an improvement
 *
 * Three things, and none of them is obvious:
 *
 * 1. **Coverage.** The measured pipeline needs MIN_DAYS = 3 qualifying days and
 *    excludes probes reading outside their own tank. If it reaches fewer
 *    machines than the derivation, promoting it buys nothing and costs the
 *    machines it drops.
 * 2. **Agreement.** Two measurements of the same machine that disagree wildly
 *    cannot both be right, and swapping which one judges is then a coin toss
 *    dressed as a precedence rule.
 * 3. **It must not displace the operator.** CLASS_BANDS are the operator's own
 *    figures and outrank everything; this only matters for machines the class
 *    table does not name.
 *
 * The last section is the one that decides the change: machines with NO band
 * today that measurement would give one to. Those are pure gain — a drop on
 * them currently reaches INDETERMINATE for want of any expectation at all.
 */

import { prisma } from '../src/lib/prisma.js'
import { measuredBurnRates } from '../src/modules/fuel/fuel-burn-rate.service.js'
import { resolveBand, resolveClass } from '../src/modules/fuel/fuel-theft-classifier.js'
import { resolveRates, MIN_RUNS } from '../src/modules/fuel/fuel-rate.js'

const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%` : '—')
const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)
const q = (xs: number[], p: number) =>
  xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!

const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })
const vehicles = await prisma.vehicle.findMany({
  where:  { isActive: true },
  select: {
    id: true, registrationPlate: true, vehicleType: true,
    tankCapacityLitres: true, organisationId: true,
  },
})
const rates = await prisma.vehicleFuelRate.findMany({
  select: { vehicleId: true, lPerHour: true, lPerKm: true, runs: true },
})

const resolved = resolveRates(
  rates.map(r => ({ vehicleId: r.vehicleId, lPerHour: r.lPerHour, lPerKm: r.lPerKm, runs: r.runs })),
  vehicles.map(v => ({ vehicleId: v.id, organisationId: v.organisationId, vehicleType: v.vehicleType })),
)
const ownKm = new Map(rates.filter(r => r.runs >= MIN_RUNS && r.lPerKm != null).map(r => [r.vehicleId, r.lPerKm!]))

// Measured rates, per org, over the same 30 days fleet-state asks for.
const measured = new Map<string, { lPerHour: number; days: number }>()
for (const o of orgs) {
  for (const [vid, m] of await measuredBurnRates(o.id, 30)) {
    measured.set(vid, { lPerHour: m.lPerHour, days: m.days })
  }
}

console.log(`\n  Band precedence: what a measured rate would change`)
console.log(`  ${vehicles.length} active vehicles · ${rates.length} derived rates` +
            ` · ${measured.size} measured rates\n`)

let operator = 0, derivedOnly = 0, none = 0
const gain: string[] = []
const both: Array<{ plate: string; d: number; m: number; days: number; src: string }> = []
const orgOf = new Map(orgs.map(o => [o.id, o.code]))

for (const v of vehicles) {
  const code = orgOf.get(v.organisationId) ?? ''
  const id = { plate: v.registrationPlate, vehicleType: v.vehicleType, tankCapacityLitres: v.tankCapacityLitres }
  const cls = resolveClass(code, id)
  const r = resolved.get(v.id) ?? null
  const band = resolveBand(code, id,
    r == null ? null : { lPerHour: r.lPerHour, basis: r.basis, lPerKm: ownKm.get(v.id) ?? null })
  const m = measured.get(v.id)

  if (band?.source === 'operator') { operator++; continue }
  if (band != null) {
    derivedOnly++
    if (m) both.push({ plate: v.registrationPlate, d: band.lowLph, m: m.lPerHour, days: m.days, src: band.source })
    continue
  }
  none++
  if (m) {
    gain.push(`      ${padR(v.registrationPlate, 20)}${padR(v.vehicleType ?? '—', 16)}` +
              `${padL(m.lPerHour.toFixed(1), 8)} L/h over ${m.days} days`)
  }
  void cls
}

console.log('    where a band comes from today')
console.log(`      operator CLASS_BAND        ${padL(String(operator), 6)}   ${pc(operator, vehicles.length)}`)
console.log(`      derived (own or median)    ${padL(String(derivedOnly), 6)}   ${pc(derivedOnly, vehicles.length)}`)
console.log(`      nothing at all             ${padL(String(none), 6)}   ${pc(none, vehicles.length)}`)

console.log(`\n    1. COVERAGE — machines with NO band today that measurement would give one to`)
console.log(`       ${gain.length} of ${none}`)
for (const g of gain.slice(0, 25)) console.log(g)
if (gain.length > 25) console.log(`      ...and ${gain.length - 25} more`)

console.log(`\n    2. AGREEMENT — machines holding both a derived and a measured figure: ${both.length}`)
if (both.length > 0) {
  // Split by what the derived side actually IS. A vehicle's own rate and a
  // borrowed type median are not the same claim, and comparing measurement
  // against a pooled median mostly measures the median's weakness. Only the
  // 'vehicle' row answers "do two measurements of THIS machine agree".
  for (const src of ['vehicle', 'type'] as const) {
    const set = both.filter(b => b.src === src)
    if (set.length === 0) continue
    const ratios = set.map(b => b.m / b.d)
    const within = (f: number) => ratios.filter(r => r >= 1 / f && r <= f).length
    console.log(`\n       derived source = ${padR(src === 'vehicle' ? "the machine's OWN" : 'a TYPE MEDIAN', 18)} n=${set.length}`)
    console.log(`         measured / derived   p10 ${q(ratios, 0.1).toFixed(2)}x` +
                `   p50 ${q(ratios, 0.5).toFixed(2)}x   p90 ${q(ratios, 0.9).toFixed(2)}x`)
    console.log(`         within 1.5x  ${padL(String(within(1.5)), 5)}  ${pc(within(1.5), ratios.length)}` +
                `      within 3x  ${padL(String(within(3)), 5)}  ${pc(within(3), ratios.length)}`)
  }
  const ratios = both.map(b => b.m / b.d)
  console.log(`\n       the ten that disagree most`)
  for (const b of [...both].sort((x, y) => Math.abs(Math.log(y.m / y.d)) - Math.abs(Math.log(x.m / x.d))).slice(0, 10)) {
    console.log(`      ${padR(b.plate, 20)}derived ${padL(b.d.toFixed(1), 7)}   measured ${padL(b.m.toFixed(1), 7)}` +
                `   ${padL(`${(b.m / b.d).toFixed(1)}x`, 7)}   ${b.days} days`)
  }
}

console.log(`\n    3. DISPLACEMENT — operator bands are unaffected by construction (${operator} machines).\n`)

process.exit(0)
