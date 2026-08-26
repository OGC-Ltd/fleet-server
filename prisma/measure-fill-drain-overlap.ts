/**
 * Does a filling need to know about drains, the way a drain knows about
 * fillings?
 *
 * READ-ONLY. It writes nothing and judges nothing.
 *
 * ## The question
 *
 * `adjudicateDrain` takes a `fillingAt` and cuts its recovery window at it.
 * `adjudicateFilling` takes nothing about drains — the asymmetry noted in
 * §1.2 of the fuel accuracy plan. The case that motivates closing it is
 * `MUFINDI - EX 22`, which ran -21.7, +29.1, +24.8, -27.7, +28.2 L in four
 * minutes: an oscillating probe whose up-swings Wialon logged as deliveries.
 *
 * But the filling adjudicator may already catch these without being told.
 * It compares the MEDIAN of the 20 minutes before the fill against the MEDIAN
 * of the settled window after it, and on a probe that swings symmetrically
 * those two medians are the same — so the rise is ~0 and the row is ruled
 * REDISTRIBUTION anyway, for reasons having nothing to do with the drain.
 *
 * So the change is only worth building if fillings that overlap a drain are
 * coming out REFILL. This measures exactly that, and nothing else.
 *
 * ## Reading the result
 *
 * The verdict split for overlapping fillings is the whole answer:
 *
 *   mostly REDISTRIBUTION  → the median test already handles it. SKIP the
 *                            change; record the measurement and move on.
 *   materially REFILL      → real fuel-in volume is being credited on rows
 *                            with a drain sitting inside their own evidence
 *                            window. BUILD it.
 *
 * `level-rose` is the reason that matters among the REFILLs: those are the
 * ones our own telemetry corroborated, so if a drain overlaps THOSE the two
 * ledgers are disagreeing about the same minutes.
 */

import { prisma } from '../src/lib/prisma.js'

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt
}
const DAYS = Number(arg('days', '30'))

// The filling adjudicator's own evidence window — FILL_LOOKBEHIND_MINUTES
// behind, FILL_SETTLE + FILL_HOLD ahead. Kept as literals rather than imported
// so a change to the module cannot silently re-scope a past measurement.
const LOOKBEHIND_MIN = 20
const AHEAD_MIN      = 60

const since = new Date(Date.now() - DAYS * 86_400_000)

const pct = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : '—'
const L   = (ml: number | bigint) => `${(Number(ml) / 1000).toFixed(1)} L`
const padR = (s: string, n: number) => s.padEnd(n)
const padL = (s: string, n: number) => s.padStart(n)

console.log(`\nFillings in the last ${DAYS} days, and whether a drain sits inside`)
console.log(`their evidence window (-${LOOKBEHIND_MIN} min … +${AHEAD_MIN} min).\n`)

// ── 1. how big is the overlapping population at all ─────────────────────────

const [totals] = await prisma.$queryRaw<Array<{ fillings: bigint; overlapping: bigint }>>`
  SELECT count(*)                                          AS fillings,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM fuel_thefts t
            WHERE t.vehicle_id = f.vehicle_id
              AND t.began_at    <= f.filled_at + make_interval(mins => ${AHEAD_MIN})
              AND t.detected_at >= f.filled_at - make_interval(mins => ${LOOKBEHIND_MIN})
         ))                                                AS overlapping
    FROM fuel_fillings f
   WHERE f.filled_at >= ${since}
`
const nFill = Number(totals?.fillings ?? 0)
const nOver = Number(totals?.overlapping ?? 0)

console.log(`  fillings in window        ${padL(String(nFill), 7)}`)
console.log(`  ...with a drain inside    ${padL(String(nOver), 7)}  ${pct(nOver, nFill)}`)

if (nOver === 0) {
  console.log('\n  No overlap at all. The asymmetry is theoretical on this ledger — SKIP.\n')
  process.exit(0)
}

// ── 2. what verdicts did the overlapping ones get ───────────────────────────
//
// This is the decision. A REDISTRIBUTION here is the median test already doing
// the job; a REFILL is fuel-in volume credited despite a drain in the window.

const split = await prisma.$queryRaw<Array<{
  verdict: string; reason: string | null; n: bigint; claimed: bigint; observed: bigint | null
}>>`
  SELECT f.verdict,
         f.verdict_reason                    AS reason,
         count(*)                            AS n,
         sum(f.filled_ml)                    AS claimed,
         sum(coalesce(f.observed_rise_ml,0)) AS observed
    FROM fuel_fillings f
   WHERE f.filled_at >= ${since}
     AND EXISTS (
       SELECT 1 FROM fuel_thefts t
        WHERE t.vehicle_id = f.vehicle_id
          AND t.began_at    <= f.filled_at + make_interval(mins => ${AHEAD_MIN})
          AND t.detected_at >= f.filled_at - make_interval(mins => ${LOOKBEHIND_MIN})
     )
   GROUP BY f.verdict, f.verdict_reason
   ORDER BY count(*) DESC
`

console.log('\n  verdicts on the OVERLAPPING fillings')
console.log(`    ${padR('verdict', 16)}${padR('reason', 24)}${padL('n', 6)}${padL('claimed', 12)}${padL('our rise', 12)}`)
for (const r of split) {
  console.log(`    ${padR(r.verdict, 16)}${padR(r.reason ?? '—', 24)}${padL(String(Number(r.n)), 6)}` +
              `${padL(L(r.claimed), 12)}${padL(L(r.observed ?? 0), 12)}`)
}

// ── 3. the same split for NON-overlapping fillings, as the control ──────────
//
// Without this the numbers above have nothing to be compared against: if half
// of ALL fillings are REDISTRIBUTION then half of the overlapping ones being
// REDISTRIBUTION says nothing about the overlap.

const control = await prisma.$queryRaw<Array<{ verdict: string; n: bigint }>>`
  SELECT f.verdict, count(*) AS n
    FROM fuel_fillings f
   WHERE f.filled_at >= ${since}
     AND NOT EXISTS (
       SELECT 1 FROM fuel_thefts t
        WHERE t.vehicle_id = f.vehicle_id
          AND t.began_at    <= f.filled_at + make_interval(mins => ${AHEAD_MIN})
          AND t.detected_at >= f.filled_at - make_interval(mins => ${LOOKBEHIND_MIN})
     )
   GROUP BY f.verdict
   ORDER BY count(*) DESC
`

const overByVerdict = new Map<string, number>()
for (const r of split) overByVerdict.set(r.verdict, (overByVerdict.get(r.verdict) ?? 0) + Number(r.n))
const ctlByVerdict = new Map(control.map(r => [r.verdict, Number(r.n)]))
const nCtl = [...ctlByVerdict.values()].reduce((a, b) => a + b, 0)

console.log('\n  overlapping vs not — the comparison that decides it')
console.log(`    ${padR('verdict', 18)}${padL('overlapping', 14)}${padL('no drain', 14)}`)
for (const v of new Set([...overByVerdict.keys(), ...ctlByVerdict.keys()])) {
  const o = overByVerdict.get(v) ?? 0
  const c = ctlByVerdict.get(v) ?? 0
  console.log(`    ${padR(v, 18)}${padL(pct(o, nOver), 14)}${padL(pct(c, nCtl), 14)}`)
}

// ── 4. the sharp end: corroborated refills with a drain in the window ───────
//
// A `level-rose` REFILL means our telemetry watched the tank gain fuel. A drain
// inside that same window means Wialon also reported it LOSING fuel. Both
// cannot be describing the tank. These are the rows a drain-aware filling rule
// would actually change, and if there are none, there is nothing to build.

const sharp = await prisma.$queryRaw<Array<{
  plate: string | null; filled_at: Date; filled_ml: number; observed_rise_ml: number | null;
  drains: bigint; drained_ml: bigint
}>>`
  SELECT v.registration_plate AS plate, f.filled_at, f.filled_ml, f.observed_rise_ml,
         (SELECT count(*) FROM fuel_thefts t
           WHERE t.vehicle_id = f.vehicle_id
             AND t.began_at    <= f.filled_at + make_interval(mins => ${AHEAD_MIN})
             AND t.detected_at >= f.filled_at - make_interval(mins => ${LOOKBEHIND_MIN})) AS drains,
         (SELECT coalesce(sum(t.stolen_ml),0) FROM fuel_thefts t
           WHERE t.vehicle_id = f.vehicle_id
             AND t.began_at    <= f.filled_at + make_interval(mins => ${AHEAD_MIN})
             AND t.detected_at >= f.filled_at - make_interval(mins => ${LOOKBEHIND_MIN})) AS drained_ml
    FROM fuel_fillings f
    JOIN vehicles v ON v.id = f.vehicle_id
   WHERE f.filled_at >= ${since}
     AND f.verdict = 'REFILL'
     AND f.verdict_reason = 'level-rose'
     AND EXISTS (
       SELECT 1 FROM fuel_thefts t
        WHERE t.vehicle_id = f.vehicle_id
          AND t.began_at    <= f.filled_at + make_interval(mins => ${AHEAD_MIN})
          AND t.detected_at >= f.filled_at - make_interval(mins => ${LOOKBEHIND_MIN})
     )
   ORDER BY f.filled_ml DESC
   LIMIT 15
`

console.log(`\n  CORROBORATED refills (level-rose) with a drain in the window: ${sharp.length}${sharp.length === 15 ? '+ (capped)' : ''}`)
if (sharp.length === 0) {
  console.log('    none — the median test is already ruling these out on its own.')
} else {
  console.log(`    ${padR('plate', 18)}${padR('when', 20)}${padL('claimed', 10)}${padL('our rise', 10)}${padL('drains', 8)}${padL('drained', 10)}`)
  for (const r of sharp) {
    console.log(`    ${padR(r.plate ?? '—', 18)}${padR(r.filled_at.toISOString().slice(0, 16).replace('T', ' '), 20)}` +
                `${padL(L(r.filled_ml), 10)}${padL(r.observed_rise_ml == null ? '—' : L(r.observed_rise_ml), 10)}` +
                `${padL(String(Number(r.drains)), 8)}${padL(L(r.drained_ml), 10)}`)
  }
}

console.log()
process.exit(0)
