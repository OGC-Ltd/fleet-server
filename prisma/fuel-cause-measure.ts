/**
 * Step 2 of `docs/fuel-theft-discrimination-plan.md` — the measurement harness.
 *
 * READ-ONLY. It writes nothing, judges nothing and publishes nothing. Its whole
 * job is to replay drains that already carry a verdict and print the
 * DISTRIBUTIONS the classifier's thresholds have to be chosen against, so that
 * the numbers in `fuel-theft-classifier.ts` are measured rather than adopted
 * from an outline.
 *
 * The plan's §6 records why that matters here specifically: of the four figures
 * the original outline proposed, one (a 5-minute median window) is already
 * known to be wider than the median SUKARI drain, and another (1% of tank
 * volume) rests on a declared capacity that disagrees with the probe on 180 of
 * 299 units. Adopting them unmeasured would bake both errors into a live theft
 * alert.
 *
 * ## What it reports
 *
 *   1. Coverage — how many drains can even be measured, and why the rest cannot
 *   2. Engine state during the fall — the split the whole design rests on
 *   3. Implied burn rate ÷ expected rate — sets the ENGINE_BURN band and the
 *      impossible-physics multiple
 *   4. Parked drop rates and magnitudes — sets the siphon floors
 *   5. Shape (kT, half-slope ratio) — sets the settling discriminator
 *   6. Shape against the EXISTING verdict, which is the only external check
 *      available on whether the shape test separates anything real
 *
 * ## Cost
 *
 * One indexed range scan per drain on `(vehicle_id, captured_at)`, run
 * sequentially. The instance is a 1 GB RDS holding a 5.9 GB database, so this
 * deliberately does not do one wide scan across every drain at once — see
 * `fuel-rate.service` for the same reasoning about window functions on this
 * box. `--days` and `--limit` scope it further.
 *
 * Usage:
 *   npx cross-env DOTENV_CONFIG_PATH=.env.example npx tsx prisma/fuel-cause-measure.ts [--days 30] [--limit 500] [--org KASULU]
 */

import { prisma } from '../src/lib/prisma.js'
import { smoothLevels } from '../src/modules/fuel/fuel-adjudication.js'
import {
  measureFall, fitLinear, halfSlopeRatio, type FallSample,
} from '../src/modules/fuel/fuel-drop-shape.js'
import { LOOKBEHIND_MS, LOOKAHEAD_MS } from '../src/modules/fuel/fuel-adjudication.service.js'
import { resolveRates } from '../src/modules/fuel/fuel-rate.js'

// ─── args ──────────────────────────────────────────────────────────────────

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt
}
const DAYS  = Number(arg('days', '30'))
const LIMIT = Number(arg('limit', '4000'))
const ORG   = arg('org', '')

// ─── small stats helpers ───────────────────────────────────────────────────

const pct = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)))]!
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
const padL = (s: string, n: number): string => s.length >= n ? s : ' '.repeat(n - s.length) + s
const f1 = (x: number): string => Number.isFinite(x) ? x.toFixed(1) : '—'
const f2 = (x: number): string => Number.isFinite(x) ? x.toFixed(2) : '—'

function dist(label: string, xs: readonly number[], fmt: (x: number) => string = f2): void {
  if (xs.length === 0) { console.log(`  ${pad(label, 30)} (no data)`); return }
  console.log(
    `  ${pad(label, 30)} n=${padL(String(xs.length), 5)}` +
    `  p10 ${padL(fmt(pct(xs, 10)), 9)}` +
    `  p25 ${padL(fmt(pct(xs, 25)), 9)}` +
    `  p50 ${padL(fmt(pct(xs, 50)), 9)}` +
    `  p75 ${padL(fmt(pct(xs, 75)), 9)}` +
    `  p90 ${padL(fmt(pct(xs, 90)), 9)}` +
    `  p99 ${padL(fmt(pct(xs, 99)), 9)}`,
  )
}

/** Counts by key, printed descending with shares. */
function breakdown(label: string, rows: ReadonlyArray<string>): void {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r, (m.get(r) ?? 0) + 1)
  console.log(`\n  ${label}  (n=${rows.length})`)
  for (const [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
    const share = rows.length ? ((n / rows.length) * 100).toFixed(1) : '0'
    console.log(`    ${pad(k, 34)} ${padL(String(n), 6)}  ${padL(share + '%', 7)}`)
  }
}

// ─── one drain, measured ───────────────────────────────────────────────────

interface Measured {
  id:        string
  plate:     string
  org:       string
  reason:    string
  claimedMl: number
  /** Drop our own smoothed series saw, baseline → trough. */
  dropMl:    number
  /** Seconds between the baseline reading and the trough. */
  fallSec:   number
  /** Engine-on seconds inside the fall. */
  engineSec: number
  /** Share of readings in the fall that carry any engine state. */
  evidence:  number
  /** Was any reading in the fall moving? */
  moved:     boolean
  /** Implied litres per engine-hour, where engine time exists. */
  impliedLph: number | null
  /** The vehicle's expected litres per engine-hour, where known. */
  expectedLph: number | null
  /** Litres per WALL-CLOCK hour — the figure a parked drop is judged on. */
  wallLph:   number
  kT:        number | null
  halfSlope: number | null
  /** Kilometres covered during the fall, integrated from reported speed. */
  distanceKm:  number | null
  /** The vehicle's own measured km per litre, where it has earned one. */
  kmPerL:      number | null
  /** Largest single-interval drop ÷ total drop. 1 = the whole fall was a step. */
  stepFraction: number
  linRmse:   number | null
  decRmse:   number | null
  samples:   number
}

async function measureOne(
  t: { id: string; vehicleId: string; beganAt: Date; detectedAt: Date; stolenMl: number
       verdictReason: string | null
       vehicle: { registrationPlate: string; organisation: { code: string } | null } },
  rateByVehicle: Map<string, number>,
  kmPerLByVehicle: Map<string, number>,
): Promise<Measured | null> {
  const from = new Date(t.beganAt.getTime() - LOOKBEHIND_MS)
  const to   = new Date(t.detectedAt.getTime() + LOOKAHEAD_MS)

  // ── why this is raw SQL and not `findMany` ───────────────────────────────
  //
  // `vehicle_telemetries.engine_on` is NOT NULL with a default of false, and
  // the Wialon adapter fills it as `ignitionOn ?? (speed > 0)` — so where a
  // unit reports no ignition, the column silently becomes a restatement of
  // whether the vehicle was moving.
  //
  // That breaks the central gate of this whole design. "Engine off and
  // stationary" is the condition a siphon verdict requires, and on a unit
  // without ignition it is TRUE OF EVERY PARKED VEHICLE by construction,
  // whether or not the engine was actually turning. The first smoke run read
  // engine evidence at 100% on every drain, which is not a coverage figure —
  // it is the absence of one.
  //
  // `ignition_known` is written into the raw payload by the same adapter
  // precisely so consumers can tell a measured engine state from the fallback,
  // and it is the only way to ask the question honestly. The join is on the
  // raws table's primary key.
  const rows = await prisma.$queryRaw<Array<{
    captured_at: Date; fuel_level_ml: number; engine_on: boolean
    speed_kmh: number | null; ignition_known: boolean | null
  }>>`
    SELECT t.captured_at, t.fuel_level_ml, t.engine_on, t.speed_kmh,
           (r.payload->>'ignition_known')::boolean AS ignition_known
      FROM vehicle_telemetries t
      JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
     WHERE t.vehicle_id = ${t.vehicleId}
       AND t.captured_at >= ${from} AND t.captured_at <= ${to}
       AND t.fuel_level_ml IS NOT NULL
     ORDER BY t.captured_at ASC`
  if (rows.length < 6) return null

  // The SAME measurement the live sweep runs — `measureFall` in
  // `fuel-drop-shape`, called by both. This file exists to choose thresholds
  // that will be applied by `classifyDrain`, and a harness that measured the
  // fall even slightly differently would be tuning against a fall the live
  // pass never sees.
  const fallSamples: FallSample[] = rows.map(r => ({
    capturedAt:  r.captured_at,
    fuelLevelMl: r.fuel_level_ml,
    engineOn:    r.ignition_known === true ? r.engine_on : undefined,
    speedKmh:    r.speed_kmh,
  }))
  const measured = measureFall(fallSamples, t, smoothLevels)
  if (measured == null) return null
  const { evidence: ev, fall } = measured

  const dropL      = ev.dropMl / 1000
  const impliedLph = ev.engineSeconds > 60 ? dropL / (ev.engineSeconds / 3600) : null
  const wallLph    = dropL / (ev.fallSeconds / 3600)

  // Diagnostics the CLASSIFIER does not use, computed from the same fall
  // segment rather than a re-derived one.
  const lin = fitLinear(fall)

  return {
    id: t.id, plate: t.vehicle.registrationPlate, org: t.vehicle.organisation?.code ?? '?',
    reason: t.verdictReason ?? '(none)',
    claimedMl: t.stolenMl,
    dropMl: ev.dropMl, fallSec: ev.fallSeconds, engineSec: ev.engineSeconds,
    evidence: ev.engineEvidence, moved: ev.moved,
    impliedLph, expectedLph: rateByVehicle.get(t.vehicleId) ?? null, wallLph,
    kT: ev.kT, halfSlope: halfSlopeRatio(fall), stepFraction: ev.stepFraction,
    distanceKm: ev.distanceKm,
    kmPerL: kmPerLByVehicle.get(t.vehicleId) ?? null,
    linRmse: lin?.rmse ?? null,
    // Back to millilitres: the dump's consumers divide by dropMl themselves.
    decRmse: ev.decayResidual != null ? ev.decayResidual * ev.dropMl : null,
    samples: ev.samples,
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const since = new Date(Date.now() - DAYS * 86_400_000)

  const drains = await prisma.fuelTheft.findMany({
    where: {
      verdict: 'DRAIN',
      beganAt: { gte: since },
      ...(ORG ? { vehicle: { organisation: { code: ORG } } } : {}),
    },
    select: {
      id: true, vehicleId: true, beganAt: true, detectedAt: true, stolenMl: true,
      verdictReason: true,
      vehicle: { select: { registrationPlate: true, organisation: { select: { code: true } } } },
    },
    orderBy: { beganAt: 'desc' },
    take: LIMIT,
  })

  console.log(`\nDRAIN rows in scope: ${drains.length}  (last ${DAYS} days${ORG ? `, org ${ORG}` : ''})`)

  // Expected rates, resolved exactly the way the server resolves them —
  // per-vehicle where earned, type median otherwise. The first smoke run used
  // the raw table and reported 8.5% coverage, which is true of OWN rates and
  // badly misleading about the gate: the fallback is the dominant path (689 of
  // 815 vehicles borrow one), so measuring without it would have condemned the
  // burn gates on a coverage figure they do not actually have.
  const rateRows = await prisma.vehicleFuelRate.findMany({
    select: { vehicleId: true, lPerHour: true, lPerKm: true, runs: true },
  })
  const groupRows = await prisma.vehicle.findMany({
    select: { id: true, organisationId: true, vehicleType: true },
  })
  const resolved = resolveRates(
    rateRows.map(r => ({ vehicleId: r.vehicleId, lPerHour: r.lPerHour, lPerKm: r.lPerKm, runs: r.runs })),
    groupRows.map(v => ({ vehicleId: v.id, organisationId: v.organisationId, vehicleType: String(v.vehicleType) })),
  )
  const rateByVehicle = new Map([...resolved].map(([id, r]) => [id, r.lPerHour]))
  // Only a vehicle's OWN lPerKm is usable: a type median pools machines that
  // travel differently, so its distance figure describes nothing.
  const kmPerLByVehicle = new Map(
    rateRows.filter(r => r.runs >= 3 && r.lPerKm != null && r.lPerKm > 0)
            .map(r => [r.vehicleId, 1 / r.lPerKm!]))
  const ownRates = rateRows.filter(r => r.runs >= 3).length
  console.log(`Expected L/h available for ${rateByVehicle.size} vehicles ` +
              `(${ownRates} own, ${rateByVehicle.size - ownRates} borrowed from a type median)`)

  const out: Measured[] = []
  let skipped = 0
  for (const [i, d] of drains.entries()) {
    const m = await measureOne(d, rateByVehicle, kmPerLByVehicle)
    if (m) out.push(m); else skipped++
    if ((i + 1) % 250 === 0) process.stderr.write(`  …${i + 1}/${drains.length}\n`)
  }

  console.log(`\nMeasured: ${out.length}   ·   unmeasurable (too few readings / no observed fall): ${skipped}`)

  // ── 1. coverage ──
  console.log('\n═══ 1. what we can measure ═══')
  const withEngineEvidence = out.filter(m => m.evidence >= 0.5)
  const withExpected       = out.filter(m => m.expectedLph != null)
  console.log(`  engine state on >=50% of fall readings   ${withEngineEvidence.length} / ${out.length}  ${((withEngineEvidence.length / out.length) * 100).toFixed(1)}%`)
  console.log(`  vehicle has its own expected L/h         ${withExpected.length} / ${out.length}  ${((withExpected.length / out.length) * 100).toFixed(1)}%`)
  console.log(`  both                                     ${out.filter(m => m.evidence >= 0.5 && m.expectedLph != null).length} / ${out.length}`)

  console.log(`  fall carries a distance          ${out.filter(m => m.distanceKm != null).length} / ${out.length}`)
  console.log(`  ...and a km/L baseline (road)    ${out.filter(m => m.distanceKm != null && m.kmPerL != null).length} / ${out.length}`)

  // ── 2. engine state during the fall ──
  //
  // The split the entire design rests on: theft is only ever claimed on a
  // machine that was NOT running. If most falls happen with the engine on,
  // the siphon branch will see very few drains and that has to be known now
  // rather than discovered after the gate is live.
  console.log('\n═══ 2. engine state during the fall ═══')
  const runFrac = (m: Measured): number => m.fallSec > 0 ? m.engineSec / m.fallSec : 0
  const stateOf = (m: Measured): string => {
    if (m.evidence < 0.5)     return 'unknown (no ignition data)'
    if (m.moved)              return 'moved during fall'
    const f = runFrac(m)
    if (f >= 0.8)             return 'running (>=80% of fall)'
    if (f >= 0.2)             return 'intermittent (20-80%)'
    if (f > 0)                return 'mostly off (<20%)'
    return 'OFF throughout, stationary'
  }
  breakdown('fall state', out.map(stateOf))
  dist('engine-on fraction of fall', out.filter(m => m.evidence >= 0.5).map(runFrac))

  // ── 3. burn rate against expectation ──
  console.log('\n═══ 3. implied burn rate vs the machine\'s own expected rate ═══')
  const running = out.filter(m => m.impliedLph != null && m.expectedLph != null && m.engineSec > 0.5 * m.fallSec)
  dist('implied L/h (running)',   running.map(m => m.impliedLph!))
  dist('expected L/h (running)',  running.map(m => m.expectedLph!))
  dist('implied / expected',      running.map(m => m.impliedLph! / m.expectedLph!))
  console.log('\n  → the ENGINE_BURN band is the low end of implied/expected;')
  console.log('    the impossible-physics multiple is where that ratio stops being credible.')

  // ── 4. the parked population — where a siphon would live ──
  console.log('\n═══ 4. parked falls (engine off, stationary, ignition known) ═══')
  const parked = out.filter(m => m.evidence >= 0.5 && !m.moved && (m.fallSec > 0 ? m.engineSec / m.fallSec : 0) < 0.2)
  dist('drop, litres',            parked.map(m => m.dropMl / 1000))
  dist('fall duration, minutes',  parked.map(m => m.fallSec / 60))
  dist('drop rate, L/h',          parked.map(m => m.wallLph))
  dist('readings in the fall',    parked.map(m => m.samples), x => x.toFixed(0))
  console.log('\n  → the siphon rate floor sits in this L/h distribution; the outline proposed 2 L/h.')

  // ── 5. shape ──
  //
  // kT and the half-slope ratio answer the same question two ways. They are
  // reported side by side because a threshold on either is only trustworthy if
  // the other agrees — a curve fit can be talked into anything by noise, and
  // the half-slope ratio cannot, but the half-slope ratio is blunt.
  console.log('\n═══ 5. shape of the fall ═══')
  const shaped = parked.filter(m => m.kT != null && m.halfSlope != null && m.samples >= 8)
  dist('kT (parked)',               shaped.map(m => m.kT!))
  dist('half-slope ratio (parked)', shaped.map(m => m.halfSlope!))
  dist('step fraction (parked)',    shaped.map(m => m.stepFraction))
  dist('rmse decay / linear',       shaped.filter(m => (m.linRmse ?? 0) > 0).map(m => m.decRmse! / m.linRmse!))
  console.log('\n  → THREE shapes, not two. Step fraction is the one that answers the operator\'s')
  console.log('    own description of theft ("hard and sharp drops"): a step is neither a line')
  console.log('    nor a decay, and fitted as a decay it rails kT at the top of the scan.')
  console.log('    rmse ratio is <= 1 almost always (the decay family contains the line),')
  console.log('    so it must NOT be the discriminator.')

  // How the parked falls divide on shape alone. Printed as a breakdown rather
  // than percentiles because these are three populations, not one continuum,
  // and percentiles over a mixture describe none of them.
  breakdown('parked falls by shape', shaped.map((m) => {
    if (m.stepFraction >= 0.8)                 return 'STEP (>=80% in one interval)'
    if (m.stepFraction >= 0.5)                 return 'mostly step (50-80%)'
    if ((m.kT ?? 0) >= 1 && (m.halfSlope ?? 1) < 0.5) return 'DECAY (settling-shaped)'
    if ((m.halfSlope ?? 0) >= 0.5)             return 'LINEAR (steady fall)'
    return 'other / ambiguous'
  }))

  const allShaped = out.filter(m => m.kT != null && m.halfSlope != null && m.samples >= 8)
  console.log('')
  dist('kT (all falls)',            allShaped.map(m => m.kT!))
  dist('half-slope (all falls)',    allShaped.map(m => m.halfSlope!))
  dist('step fraction (all falls)', allShaped.map(m => m.stepFraction))

  // ── 6. shape against the existing verdict reason ──
  //
  // The only external check available. `level-stayed-down` is a drain our own
  // telemetry watched fall and not return; `drop-not-observed` and
  // `no-drop-observed` are ones where our series disagreed with the claim. If
  // the shape statistics do not differ between those populations, the shape
  // test is measuring noise and must not gate anything.
  console.log('\n═══ 6. shape by existing verdict reason (the only external check) ═══')
  for (const reason of [...new Set(allShaped.map(m => m.reason))].sort()) {
    const g = allShaped.filter(m => m.reason === reason)
    if (g.length < 5) continue
    console.log(`\n  ${reason}  (n=${g.length})`)
    dist('    kT',          g.map(m => m.kT!))
    dist('    half-slope',  g.map(m => m.halfSlope!))
    dist('    step frac',   g.map(m => m.stepFraction))
    dist('    drop L',      g.map(m => m.dropMl / 1000))
  }

  // ── 7. the ones that would fire ──
  //
  // A draft SIPHON gate at the outline's own numbers, printed as a worked
  // example rather than as a recommendation — it shows what the shape of the
  // answer looks like and how many rows a night it would put in front of an
  // operator, which is the number that decides whether this is usable at all.
  console.log('\n═══ 7. worked example — outline thresholds, NOT a recommendation ═══')
  const DRAFT_MIN_LPH   = 2
  const DRAFT_MIN_MIN   = 10
  const DRAFT_MAX_KT    = 1.0
  const DRAFT_MIN_SLOPE = 0.5
  const wouldFire = parked.filter(m =>
    m.wallLph >= DRAFT_MIN_LPH &&
    m.fallSec >= DRAFT_MIN_MIN * 60 &&
    (m.kT ?? 0) <= DRAFT_MAX_KT &&
    (m.halfSlope ?? 0) >= DRAFT_MIN_SLOPE)
  console.log(`  parked falls:                 ${parked.length}`)
  console.log(`  would fire as SIPHON:         ${wouldFire.length}`)
  console.log(`  ...per day over ${DAYS} days:  ${(wouldFire.length / DAYS).toFixed(1)}`)
  console.log(`  today the same window notifies: ${out.length} (every DRAIN)`)
  if (wouldFire.length > 0) {
    console.log('\n  the ten largest:')
    for (const m of [...wouldFire].sort((a, b) => b.dropMl - a.dropMl).slice(0, 10)) {
      console.log(`    ${pad(m.plate, 18)} ${padL(f1(m.dropMl / 1000), 7)} L  ` +
                  `${padL(f1(m.fallSec / 60), 6)} min  ${padL(f1(m.wallLph), 6)} L/h  ` +
                  `kT ${padL(f2(m.kT ?? NaN), 6)}  slope ${padL(f2(m.halfSlope ?? NaN), 5)}  ${m.reason}`)
    }
  }

  // ── 8. the burn-rate threshold grid ──
  //
  // The operator chose burn rate as the PRIMARY rule (2026-08-16), so this is
  // the table the thresholds are actually picked from. There is no ground
  // truth for theft on this ledger — the existing verdicts describe whether
  // fuel came back, not why it left — so this cannot report accuracy, and it
  // deliberately does not pretend to. What it reports is ALERT VOLUME at each
  // multiple, which is the quantity the operator can actually judge: an alert
  // rate nobody can work through is a filter that will be ignored, whatever
  // its precision.
  console.log('\n═══ 8. burn-rate threshold grid (the decision table) ═══\n')
  const rated = out.filter(m => m.impliedLph != null && m.expectedLph != null)
  console.log(`  drains with both an implied and an expected rate: ${rated.length} of ${out.length}`)
  console.log(`  (a drain with no engine time in the fall has no implied rate and cannot be judged this way)\n`)
  console.log('  multiple   fires   per day   median drop L   median excess L   share of measured')
  console.log('  ' + '─'.repeat(76))
  for (const mult of [1.5, 2, 3, 4, 5, 8, 10, 20, 50]) {
    const fires = rated.filter(m => m.impliedLph! / m.expectedLph! >= mult)
    if (fires.length === 0) { console.log(`  ${padL(mult + 'x', 7)} ${padL('0', 7)}`); continue }
    // Excess is the litres NOT explained by the machine's own expected burn —
    // the part a reader would actually be asked to account for.
    const excess = fires.map((m) => {
      const expectedMl = m.expectedLph! * (m.engineSec / 3600) * 1000
      return Math.max(0, m.dropMl - expectedMl) / 1000
    })
    console.log(
      `  ${padL(mult + 'x', 7)} ${padL(String(fires.length), 7)} ${padL((fires.length / DAYS).toFixed(1), 9)}` +
      `   ${padL(f1(pct(fires.map(m => m.dropMl / 1000), 50)), 13)}` +
      `   ${padL(f1(pct(excess, 50)), 15)}` +
      `   ${padL(((fires.length / out.length) * 100).toFixed(1) + '%', 17)}`,
    )
  }

  // The same grid restricted to falls where the engine was PROVABLY off — the
  // higher-severity subset the operator asked to keep alongside the primary
  // rule. These have no implied rate at all (no engine time), so they are
  // selected on wall-clock rate instead.
  console.log('\n  parked subset, by wall-clock drop rate:')
  console.log('  L/h floor   fires   per day   median drop L')
  console.log('  ' + '─'.repeat(50))
  for (const floor of [2, 5, 10, 20, 40]) {
    const fires = parked.filter(m => m.wallLph >= floor)
    console.log(`  ${padL(floor + ' L/h', 9)} ${padL(String(fires.length), 7)} ${padL((fires.length / DAYS).toFixed(2), 9)}` +
                `   ${padL(fires.length ? f1(pct(fires.map(m => m.dropMl / 1000), 50)) : '—', 13)}`)
  }

  // ── the dump ──
  //
  // One expensive pass, many analyses. This run costs ~45 minutes against a
  // 1 GB RDS because of the raw-payload join, and every threshold question
  // asked afterwards would otherwise re-pay it. With the rows on disk the
  // grid above can be re-cut in seconds without touching the database.
  const dumpPath = arg('dump', '')
  if (dumpPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(dumpPath, JSON.stringify(out, null, 0))
    console.log(`\n  wrote ${out.length} measured drains to ${dumpPath}`)
  }

  console.log('')
  await prisma.$disconnect()
}

main().catch(async (err: unknown) => {
  console.error(err)
  await prisma.$disconnect()
  process.exitCode = 1
})
