/**
 * Displacement-mirror analysis over the fuel ledger. READ-ONLY.
 *
 * When fuel displaces away from the probe and settles back, Wialon records the
 * drop as a DRAIN and the return as a FILLING. Both rows enter the ledger: the
 * drain inflates reported loss, the filling inflates reported consumption. The
 * filling also blocks the existing recovery test in fuel-adjudication.ts, so the
 * very event proving the fuel came back is what stops it being ruled
 * REDISTRIBUTION.
 *
 * This script measures the size of that population. It writes nothing.
 *
 * See docs/fuel-displacement-mirror.md for the findings, the tolerance sweep,
 * the safety analysis, and why RET/BURN are set where they are.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 * On the production box (which runs dist/, not src/):
 *
 *   export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH
 *   cd /home/ubuntu/prod/fleet-server
 *   node --env-file=.env scripts/fuel-mirror.mjs [FROM_ISO] [TO_ISO]
 *
 * Do NOT use the `npm run` wrappers — they load .env.example, whose DATABASE_URL
 * points at the dev SSH tunnel on localhost:15432, which does not exist there.
 *
 *   node --env-file=.env scripts/fuel-mirror.mjs                       # since 01 Aug
 *   node --env-file=.env scripts/fuel-mirror.mjs 2026-07-05T21:00:00Z  # from a date
 *
 * Fleet time is EAT (UTC+3) with no DST, so a local midnight boundary is 21:00Z
 * the previous day.
 */

import { prisma } from '../dist/src/lib/prisma.js'

/** Start of the window. Default 01 Aug 2026 00:00 EAT. */
const FROM = new Date(process.argv[2] ?? '2026-07-31T21:00:00.000Z')
const TO   = new Date(process.argv[3] ?? Date.now())

/** How long after a drain a mirroring filling may appear. */
const WIN = 120

/**
 * How close the tank must return to its pre-drain level, as a fraction of that
 * level. This is the DECIDING test: measured on live rows, several true pairs
 * return to exactly the starting level while their volumes differ, because the
 * level drifted further down between the drain and the refill. Volume equality
 * was tried first and is the weaker signal — it is deliberately not used.
 */
const RET = 0.03

/**
 * Net deficit forgiven as fuel genuinely burned while the machine idled, as a
 * fraction of the drain volume. Accepted pairs routinely sit a few litres below
 * where they started: displacement plus real consumption.
 */
const BURN = 0.25

/** A genuine depot refuel is a large fraction of the tank. If the rule starts
 *  catching those, it has stopped describing displacement — see the safety
 *  analysis in the doc. */
const BIG_FILL_FRACTION = 0.6

const L = ml => (ml / 1000).toFixed(1)
const ORGS = [
  ['KASULU', 'cms0oo1n40000fwv7r1u4pg36'],
  ['SUKARI', 'cmr6da1bp0000vzizby6z0dzw'],
]

console.log(`window: ${FROM.toISOString()} → ${TO.toISOString()}`)
console.log(`rule:   return-to-start ≤ ${RET * 100}% (floor 3 L) · burn allowance ${BURN * 100}% · mirror window ${WIN} min\n`)

for (const [name, org] of ORGS) {
  const drains = await prisma.fuelTheft.findMany({
    where:  { vehicle: { organisationId: org }, beganAt: { gte: FROM, lte: TO } },
    select: {
      vehicleId: true, detectedAt: true, stolenMl: true, verdict: true, initialSpeedKmh: true,
      initialFuelLevelMl: true, finalFuelLevelMl: true,
      vehicle: { select: { name: true, vehicleType: true, tankCapacityLitres: true } },
    },
  })
  const fills = await prisma.fuelFilling.findMany({
    where:  { vehicle: { organisationId: org }, filledAt: { gte: FROM, lte: TO } },
    select: { vehicleId: true, filledAt: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
  })

  const byVeh = new Map()
  for (const f of fills) {
    if (!byVeh.has(f.vehicleId)) byVeh.set(f.vehicleId, [])
    byVeh.get(f.vehicleId).push(f)
  }
  for (const a of byVeh.values()) a.sort((x, y) => x.filledAt - y.filledAt)

  const claimedMl = drains.reduce((s, d) => s + d.stolenMl, 0)
  const totalFill = fills.reduce((s, f) => s + f.filledMl, 0)
  // What /analytics/fuel-cost counts as having left the tank. Mirrors
  // analytics.repository's NO_FUEL_LEFT — kept in step by hand, because this is
  // a standalone analysis script with no import path into src.
  const NO_FUEL_LEFT = new Set(['REDISTRIBUTION', 'REFILL', 'SENSOR_FAULT'])
  const lostMl = drains.filter(d => !NO_FUEL_LEFT.has(d.verdict)).reduce((s, d) => s + d.stolenMl, 0)

  console.log('='.repeat(74))
  console.log(`${name} — ${drains.length} drains · ${fills.length} fillings (${L(totalFill)} L)`)
  console.log('='.repeat(74))

  const byVerdict = {}
  for (const d of drains) {
    byVerdict[d.verdict] = byVerdict[d.verdict] ?? { n: 0, ml: 0 }
    byVerdict[d.verdict].n++
    byVerdict[d.verdict].ml += d.stolenMl
  }
  for (const [v, o] of Object.entries(byVerdict).sort((a, b) => b[1].ml - a[1].ml)) {
    console.log(`  ${v.padEnd(15)} ${String(o.n).padStart(4)} drains · ${(L(o.ml) + ' L').padStart(10)}` +
      `  ${(o.ml / Math.max(1, claimedMl) * 100).toFixed(1)}% of claimed`)
  }
  console.log(`  → reported LOST (all but REDISTRIBUTION): ${L(lostMl)} L`)

  // ── the mirror ──
  const used = new Set()
  const hits = []
  for (const d of drains) {
    if (d.initialFuelLevelMl == null) continue
    const cands = (byVeh.get(d.vehicleId) ?? []).filter(f =>
      !used.has(f) && f.filledAt >= d.detectedAt && f.filledAt - d.detectedAt <= WIN * 60_000)
    const hit = cands.find(f => {
      if (f.finalFuelLevelMl == null) return false
      const net = f.finalFuelLevelMl - d.initialFuelLevelMl   // + above start, − below
      const tol = Math.max(3_000, d.initialFuelLevelMl * RET)
      return net <= tol && net >= -(tol + d.stolenMl * BURN)
    })
    if (hit) { used.add(hit); hits.push({ d, f: hit }) }
  }

  const reclaimedMl = hits.filter(h => !NO_FUEL_LEFT.has(h.d.verdict)).reduce((s, h) => s + h.d.stolenMl, 0)
  const excludedMl  = hits.reduce((s, h) => s + h.f.filledMl, 0)
  const stationary  = hits.filter(h => (h.d.initialSpeedKmh ?? 0) === 0).length
  const bigFills    = hits.filter(h => {
    const cap = (h.d.vehicle.tankCapacityLitres ?? 0) * 1000
    return cap > 0 && h.f.filledMl > cap * BIG_FILL_FRACTION
  }).length

  console.log(`\n  MIRRORED PAIRS: ${hits.length}` +
    (hits.length ? `  (${(stationary / hits.length * 100).toFixed(0)}% at speed 0)` : ''))
  console.log(`    loss to reclaim      ${(L(reclaimedMl) + ' L').padStart(10)}` +
    (lostMl ? `  (${(reclaimedMl / lostMl * 100).toFixed(1)}% of reported loss)` : ''))
  console.log(`    fillings to exclude  ${(L(excludedMl) + ' L').padStart(10)}` +
    (totalFill ? `  (${(excludedMl / totalFill * 100).toFixed(1)}% of filled)` : ''))
  // Should stay near zero and stay FLAT as tolerances loosen. If it climbs, the
  // rule is reaching genuine depot refuels and the tolerances are too wide.
  console.log(`    large-refuel catches ${String(bigFills).padStart(10)}  (expect ~0 — see the doc's safety analysis)`)

  // ── candidate probe faults ──
  const worst = {}
  for (const h of hits) {
    const k = h.d.vehicle.name ?? '?'
    worst[k] = worst[k] ?? { n: 0, ml: 0, type: h.d.vehicle.vehicleType }
    worst[k].n++
    worst[k].ml += h.d.stolenMl
  }
  const top = Object.entries(worst).sort((a, b) => b[1].ml - a[1].ml).slice(0, 6)
  if (top.length) {
    console.log('\n    worst offenders (candidate probe faults, not thresholds):')
    for (const [v, o] of top) {
      console.log(`      ${v.slice(0, 28).padEnd(28)} ${String(o.type ?? '?').padEnd(9)}` +
        ` ${String(o.n).padStart(3)} pairs · ${(L(o.ml) + ' L').padStart(9)}`)
    }
  }

  // ── control group: fillings the rule can never touch ──
  const drainTimes = new Map()
  for (const d of drains) {
    if (!drainTimes.has(d.vehicleId)) drainTimes.set(d.vehicleId, [])
    drainTimes.get(d.vehicleId).push(d.detectedAt)
  }
  const clean = fills.filter(f => {
    const ts = drainTimes.get(f.vehicleId) ?? []
    return !ts.some(t => f.filledAt >= t && f.filledAt - t <= WIN * 60_000)
  })
  const raise = clean.filter(f =>
    f.initialFuelLevelMl != null && f.finalFuelLevelMl != null && f.finalFuelLevelMl > f.initialFuelLevelMl)
  console.log(`\n    control: ${clean.length} fillings with no drain before them — untouchable by this rule.`)
  console.log(`             ${raise.length} of them raise the tank level, as a refuel should.`)
  console.log()
}

process.exit(0)
