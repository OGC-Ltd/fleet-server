/**
 * Does a DISTANCE machine actually have a distance rate to be judged on?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The question
 *
 * Stage 3.1 gave every machine a `ConsumptionBasis`, and 3.3 proposes storing
 * that basis on `vehicle_fuel_rates` so a road vehicle's PRIMARY figure is
 * litres per kilometre rather than litres per hour. That is only worth doing if
 * the figure exists.
 *
 * Two filters stand between a derived `l_per_km` and a usable one:
 *
 * - `MIN_RUNS` — below three qualifying runs a vehicle uses its type's median,
 *   and `lPerKm` has no median: `getBandInputs` carries only a vehicle's OWN
 *   distance figure, because a type median pools machines that travel
 *   differently.
 * - `ROAD_MIN_KM_PER_L` (1.5) — `resolveBand` discards anything below it, so a
 *   machine measured at 0.31 km/L gets no distance baseline at all.
 *
 * If most DISTANCE machines clear neither, then "primary basis = DISTANCE" would
 * name a column that is null, and the honest answer is to keep hours primary and
 * say why. That is the same shape of check that inverted the meter hypothesis:
 * ask what the rule would actually reach before building it.
 *
 * ## Reading the result
 *
 * The bottom line is the last table — DISTANCE machines with a usable km/L. If
 * that count is small the item does not fail, but its claim changes: the basis
 * becomes a statement of intent for the measured pipeline (3.4) to fill, not a
 * switch that redirects judgements today.
 */

import { prisma } from '../src/lib/prisma.js'
import { resolveBasis, ROAD_MIN_KM_PER_L } from '../src/modules/fuel/fuel-theft-classifier.js'
import { MIN_RUNS } from '../src/modules/fuel/fuel-rate.js'

const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%` : '—')
const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)

const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })
const orgCode = new Map(orgs.map(o => [o.id, o.code]))

const vehicles = await prisma.vehicle.findMany({
  select: {
    id: true, registrationPlate: true, vehicleType: true,
    tankCapacityLitres: true, organisationId: true,
  },
})
const rates = await prisma.vehicleFuelRate.findMany({
  select: { vehicleId: true, lPerHour: true, lPerKm: true, runs: true, primaryBasis: true },
})
const rateOf = new Map(rates.map(r => [r.vehicleId, r]))

console.log(`\n  Consumption basis vs the rate actually available`)
console.log(`  ${vehicles.length} vehicles · ${rates.length} derived rates` +
            ` · MIN_RUNS ${MIN_RUNS} · ROAD_MIN_KM_PER_L ${ROAD_MIN_KM_PER_L}\n`)

interface Tally {
  vehicles: number
  withRate: number      // has a derived row at all
  ownRate:  number      // ...clearing MIN_RUNS, so its own figure is used
  withKm:   number      // ...and carrying a non-null l_per_km
  usableKm: number      // ...whose km/L clears ROAD_MIN_KM_PER_L
}
const blank = (): Tally => ({ vehicles: 0, withRate: 0, ownRate: 0, withKm: 0, usableKm: 0 })
const byBasis = new Map<string, Tally>([['HOURS', blank()], ['DISTANCE', blank()]])
const byType  = new Map<string, { basis: string } & Tally>()
const usableList: Array<{ plate: string; type: string; kmPerL: number; runs: number }> = []

for (const v of vehicles) {
  const code = orgCode.get(v.organisationId) ?? ''
  const basis = resolveBasis(code, {
    plate: v.registrationPlate,
    vehicleType: v.vehicleType,
    tankCapacityLitres: v.tankCapacityLitres,
  })
  const typeKey = `${code} ${(v.vehicleType ?? 'UNSPECIFIED').toUpperCase()}`
  if (!byType.has(typeKey)) byType.set(typeKey, { basis, ...blank() })

  const bump = (t: Tally) => {
    t.vehicles++
    const r = rateOf.get(v.id)
    if (r == null) return
    t.withRate++
    if (r.runs < MIN_RUNS) return
    t.ownRate++
    if (r.lPerKm == null || r.lPerKm <= 0) return
    t.withKm++
    const kmPerL = 1 / r.lPerKm
    if (kmPerL < ROAD_MIN_KM_PER_L) return
    t.usableKm++
  }
  bump(byBasis.get(basis)!)
  bump(byType.get(typeKey)!)

  // Outside `bump` — it runs once per tally and would list every vehicle twice.
  const r = rateOf.get(v.id)
  if (basis === 'DISTANCE' && r != null && r.runs >= MIN_RUNS
      && r.lPerKm != null && r.lPerKm > 0 && 1 / r.lPerKm >= ROAD_MIN_KM_PER_L) {
    usableList.push({
      plate: v.registrationPlate, type: v.vehicleType ?? '—',
      kmPerL: 1 / r.lPerKm, runs: r.runs,
    })
  }
}

console.log('    basis      vehicles   any rate   own rate    l/km    usable km/L')
for (const [basis, t] of byBasis) {
  console.log(`    ${padR(basis, 10)}${padL(String(t.vehicles), 9)}` +
              `${padL(String(t.withRate), 11)}${padL(String(t.ownRate), 11)}` +
              `${padL(String(t.withKm), 8)}${padL(`${t.usableKm}`, 15)}`)
}
const dist = byBasis.get('DISTANCE')!
console.log(`\n    Of ${dist.vehicles} DISTANCE machines, ${dist.usableKm} have a km/L a judgement could use` +
            ` (${pc(dist.usableKm, dist.vehicles)}).`)

console.log('\n    by org + type (DISTANCE groups only, ≥1 vehicle)')
const distTypes = [...byType.entries()]
  .filter(([, t]) => t.basis === 'DISTANCE')
  .sort((a, b) => b[1].vehicles - a[1].vehicles)
for (const [key, t] of distTypes) {
  console.log(`      ${padR(key, 26)}${padL(String(t.vehicles), 6)} veh` +
              `${padL(String(t.ownRate), 6)} own${padL(String(t.usableKm), 6)} usable km/L`)
}

// ── stored basis vs what resolveBasis says today ────────────────────────────
//
// The column is written by the weekly derivation and read by nobody yet, so it
// can drift from the rule without anything failing. Drift is not automatically
// a fault -- a vehicle reclassified in Wialon SHOULD disagree until the next
// derivation -- but it has to be visible, because a stale basis on a column
// that later feeds `resolveBand` would be a wrong judgement with no symptom.
let agree = 0, differ = 0, unset = 0
const drifted: string[] = []
for (const v of vehicles) {
  const r = rateOf.get(v.id)
  if (r == null) continue
  const now = resolveBasis(orgCode.get(v.organisationId) ?? '', {
    plate: v.registrationPlate,
    vehicleType: v.vehicleType,
    tankCapacityLitres: v.tankCapacityLitres,
  })
  if (r.primaryBasis == null) { unset++; continue }
  if (r.primaryBasis === now) { agree++; continue }
  differ++
  drifted.push(`      ${padR(v.registrationPlate, 20)}stored ${padR(r.primaryBasis, 10)}rule says ${now}`)
}
console.log(`\n    stored primary_basis over ${rates.length} rate rows`)
console.log(`      agrees with the rule   ${padL(String(agree), 6)}`)
console.log(`      disagrees              ${padL(String(differ), 6)}`)
console.log(`      not yet set            ${padL(String(unset), 6)}   (machines idle since the last derivation)`)
for (const d of drifted) console.log(d)

console.log(`\n    the DISTANCE machines that would actually be judged per km:`)
if (usableList.length === 0) console.log('      (none)')
for (const u of usableList.sort((a, b) => b.kmPerL - a.kmPerL)) {
  console.log(`      ${padR(u.plate, 20)}${padR(u.type, 16)}` +
              `${padL(u.kmPerL.toFixed(2), 8)} km/L   ${u.runs} runs`)
}
console.log()

process.exit(0)
