/**
 * What would the proposed gate changes actually announce?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The claim being tested
 *
 * `docs/fuel-theft-alerting-gaps.md` proposes five constant changes and asserts
 * that the first two alone would have alerted six of eight known siphons. That
 * is a prediction from eight hand-read cases. This replays every drain in the
 * window through the same gates to find out what the fleet-wide consequence is
 * — specifically the one the operator actually pays for: **how many alerts a
 * day, and how many of them land on probes that are known to wander.**
 *
 * ## What it can and cannot replay
 *
 * `fuel_thefts` persists the measured fall shape since 2026-08-28 —
 * `fall_seconds`, `measured_drop_ml`, `step_fraction`, `engine_evidence`,
 * `implied_lph`, `fall_distance_km` — which is exactly the input
 * `classifyDrain` reads for gates 3 and 6. Those replay faithfully.
 *
 * Two things do NOT:
 *
 *   - **The SETTLING branch.** `kT` and `decayResidual` are computed and thrown
 *     away, so a row that would be caught as `decay-shaped` cannot be
 *     identified here. Every count below is therefore an UPPER BOUND on new
 *     alerts, and the true figure is lower by however many parked falls decay.
 *   - **Gates 4 and 5** (burn against band, distance). Those need
 *     `resolveBand`, a fleet-wide rate computation. Rows whose stored
 *     `cause_reason` shows they were decided there are reported separately and
 *     left alone rather than guessed at.
 *
 * So this measures the PARKED branch, which is the only route to SIPHON and the
 * only branch the proposed changes touch.
 *
 *   npx tsx prisma/measure-alerting-gates.ts --org=KASULU --days=30 --tunnel
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG    = arg('org') ?? 'KASULU'
const DAYS   = Number(arg('days') ?? 30)
const TUNNEL = process.argv.includes('--tunnel')

function connectionString(): string {
  const u = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!)
  if (TUNNEL) { u.hostname = 'localhost'; u.port = '15432' }
  return u.toString()
}

// ── the constants, as they stand and as proposed ───────────────────────────

interface Gates {
  label:            string
  minDropMl:        number
  minLph:           number
  minSeconds:       number
  maxStepFraction:  number
  maxRemovalLph:    number
  /** km inside the fall below which a stray speed sample is not "moved". */
  movedKm:          number
}

/**
 * The gates as they stood before any of this shipped. Kept as the comparison
 * baseline; it is NO LONGER production — see the SHIPPED markers below.
 */
const CURRENT: Gates = {
  label: 'S0  before any change',
  minDropMl: 15_000, minLph: 5, minSeconds: 600,
  maxStepFraction: 0.6, maxRemovalLph: 300, movedKm: 0,
}

/** Cumulative scenarios, each adding one change to the one before it. */
const SCENARIOS: Gates[] = [
  CURRENT,
  { ...CURRENT, label: 'S1  + step retired  SHIPPED',      maxStepFraction: Infinity },
  { ...CURRENT, label: 'S2  + min fall 120 s',         maxStepFraction: Infinity, minSeconds: 120 },
  { ...CURRENT, label: 'S3  + removal ceiling 3000',   maxStepFraction: Infinity, minSeconds: 120, maxRemovalLph: 3_000 },
  { ...CURRENT, label: 'S4  + stray-speed tolerance',  maxStepFraction: Infinity, minSeconds: 120, maxRemovalLph: 3_000, movedKm: 0.1 },
  { ...CURRENT, label: 'S5  + drop floor 5 L',         maxStepFraction: Infinity, minSeconds: 120, maxRemovalLph: 3_000, movedKm: 0.1, minDropMl: 5_000 },
]

interface Row {
  vehicle: string; detected: string; stolen_ml: number
  fall_seconds: number | null; measured_drop_ml: number | null
  step_fraction: number | null; engine_evidence: number | null
  fall_distance_km: number | null; implied_lph: number | null
  verdict: string; drain_cause: string | null; cause_reason: string | null
  p90: number | null; swinging: number | null; windows: number | null
}

type Outcome = 'SIPHON' | 'probe-swings' | 'slosh' | 'below-floor' | 'step-shaped'
             | 'not-parked' | 'other-branch' | 'no-evidence'

/**
 * `probeSwings` from fuel-adjudication, reproduced against the profile computed
 * here rather than re-derived — MIN_SWING_WINDOWS 3 AND SWING_SHARE 0.05.
 *
 * Omitting this was the first version's mistake. Gates 1 and 2 run BEFORE
 * everything else in `classifyDrain` and return INDETERMINATE, so a replay that
 * skips them counts alerts the shipped classifier would never raise: the first
 * run reported 16 SIPHON under current constants where the ledger holds 3.
 */
const MIN_SWING_WINDOWS = 3
const SWING_SHARE = 0.05

const probeSwings = (r: Row): boolean =>
  (r.swinging ?? 0) >= MIN_SWING_WINDOWS &&
  (r.windows ?? 0) > 0 &&
  (r.swinging ?? 0) / (r.windows ?? 1) >= SWING_SHARE

/**
 * Replay the parked branch for one row under one set of gates.
 *
 * Mirrors `classifyDrain`'s order exactly — rate ceiling, then the parked test,
 * then the floor, then the step test — because the order is what decides which
 * label a row gets, and a reordering here would measure a classifier we do not
 * ship.
 */
function replay(r: Row, g: Gates): Outcome {
  if (r.fall_seconds == null || r.measured_drop_ml == null) return 'no-evidence'

  // Gates 1-2 — an instrument we do not trust ends the enquiry, before any
  // question about the fall is asked. This is the shipped order.
  if (probeSwings(r)) return 'probe-swings'

  // Rows decided by the burn or distance gates are not this branch's business.
  if (r.cause_reason && /burn|distance/.test(r.cause_reason)) return 'other-branch'

  const dropL   = r.measured_drop_ml / 1000
  const wallLph = r.fall_seconds > 0 ? dropL / (r.fall_seconds / 3600) : 0

  // Gate 3 — a rate nothing could produce is the reading, not the tank.
  if (wallLph > g.maxRemovalLph) return 'slosh'

  // Gate 6 — the parked test. `moved` tolerates a stray sample under movedKm.
  const moved  = (r.fall_distance_km ?? 0) > g.movedKm
  const parked = (r.engine_evidence ?? 0) >= 0.5 && !moved
  if (!parked) return 'not-parked'

  if (r.measured_drop_ml < g.minDropMl || wallLph < g.minLph || r.fall_seconds < g.minSeconds) {
    return 'below-floor'
  }
  // (SETTLING would be tested here. Not replayable — see the header.)
  if ((r.step_fraction ?? 0) > g.maxStepFraction) return 'step-shaped'
  return 'SIPHON'
}

/** Trusted by the shipped gate — the inverse of `probeSwings`, not a new bound. */
const steady = (r: Row): boolean => !probeSwings(r)
const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
const L = (ml: number): string => `${(ml / 1000).toFixed(0)} L`

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

  const { rows } = await c.query<Row>(
    `WITH parked AS (
       SELECT t.vehicle_id,
              date_trunc('hour', t.captured_at)
                + interval '30 min' * floor(extract(minute from t.captured_at)/30) AS win,
              t.fuel_level_ml
         FROM vehicle_telemetries t
        WHERE t.captured_at >= now() - interval '${DAYS} days'
          AND t.fuel_level_ml IS NOT NULL
          AND coalesce(t.speed_kmh,0) = 0 AND t.engine_on = false
     ), spans AS (
       SELECT vehicle_id, win, max(fuel_level_ml) - min(fuel_level_ml) AS swing
         FROM parked GROUP BY vehicle_id, win HAVING count(*) >= 3
     ), prof AS (
       SELECT vehicle_id,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY swing) AS p90,
              count(*) FILTER (WHERE swing >= 25000) AS swinging,
              count(*) AS windows
         FROM spans GROUP BY vehicle_id
     )
     SELECT v.name AS vehicle,
            to_char(t.detected_at + interval '3 hours', 'DD Mon HH24:MI') AS detected,
            t.stolen_ml, t.fall_seconds, t.measured_drop_ml, t.step_fraction,
            t.engine_evidence, t.fall_distance_km, t.implied_lph,
            t.verdict, t.drain_cause, t.cause_reason,
            prof.p90, prof.swinging, prof.windows
       FROM fuel_thefts t
       JOIN vehicles v      ON v.id = t.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN prof       ON prof.vehicle_id = t.vehicle_id
      WHERE o.code = $1 AND t.detected_at >= now() - interval '${DAYS} days'
      ORDER BY t.detected_at`,
    [ORG],
  )

  console.log(`\n${'═'.repeat(82)}`)
  console.log(`  ${ORG} — alerting-gate replay · ${rows.length} drains · ${DAYS} days`)
  console.log(`${'═'.repeat(82)}`)

  // ── what the ledger actually says today ──────────────────────────────────
  const byCause = new Map<string, number>()
  for (const r of rows) byCause.set(r.drain_cause ?? '(none)', (byCause.get(r.drain_cause ?? '(none)') ?? 0) + 1)
  console.log(`\n  STORED CAUSES`)
  for (const [k, n] of [...byCause.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(k, 20)} ${String(n).padStart(5)}`)
  }
  const withEvidence = rows.filter(r => r.fall_seconds != null && r.measured_drop_ml != null)
  console.log(`\n  replayable (fall shape persisted)  ${withEvidence.length} of ${rows.length}`)

  // ── the scenarios ────────────────────────────────────────────────────────
  console.log(`\n  SCENARIOS — cumulative, each adds one change to the row above`)
  console.log('  ' + '─'.repeat(80))
  console.log(`  ${pad('', 28)}${pad('SIPHON', 9)}${pad('/DAY', 8)}${pad('STEADY', 9)}${pad('SWINGY', 9)}VOLUME`)
  console.log('  ' + '─'.repeat(80))

  const results = new Map<string, Row[]>()
  for (const g of SCENARIOS) {
    const hits = withEvidence.filter(r => replay(r, g) === 'SIPHON')
    results.set(g.label, hits)
    const st = hits.filter(steady).length
    const vol = hits.reduce((s, r) => s + r.stolen_ml, 0)
    console.log(
      `  ${pad(g.label, 28)}${pad(String(hits.length), 9)}` +
      `${pad((hits.length / DAYS).toFixed(1), 8)}${pad(String(st), 9)}` +
      `${pad(String(hits.length - st), 9)}${L(vol)}`,
    )
  }

  // ── leave-one-out: which change is actually load-bearing? ────────────────
  //
  // The cumulative table above is order-dependent — a change applied fourth
  // gets credit only for what the first three left behind. Removing one change
  // from the FULL proposal measures what that change alone is worth, and the
  // two answers differ: retiring the step test looks modest cumulatively and is
  // the single largest contributor here.
  const FULL = SCENARIOS[SCENARIOS.length - 1]!
  const fullHits = withEvidence.filter(r => replay(r, FULL) === 'SIPHON').length
  const LEAVE_ONE_OUT: Array<[string, Gates]> = [
    ['without step retirement', { ...FULL, maxStepFraction: 0.6 }],
    ['without 120 s fall floor', { ...FULL, minSeconds: 600 }],
    ['without removal ceiling',  { ...FULL, maxRemovalLph: 300 }],
    ['without speed tolerance',  { ...FULL, movedKm: 0 }],
    ['without 5 L drop floor',   { ...FULL, minDropMl: 15_000 }],
  ]
  console.log(`\n  LEAVE-ONE-OUT from the full proposal (${fullHits} alerts)`)
  console.log(`    ${pad('REMOVE THIS CHANGE', 30)}${pad('ALERTS', 9)}COST`)
  console.log('    ' + '─'.repeat(52))
  for (const [label, g] of LEAVE_ONE_OUT) {
    const n = withEvidence.filter(r => replay(r, g) === 'SIPHON').length
    console.log(`    ${pad(label, 30)}${pad(String(n), 9)}-${fullHits - n}`)
  }

  // ── where the rejections go, current vs fully proposed ───────────────────
  const tally = (g: Gates): Map<Outcome, number> => {
    const m = new Map<Outcome, number>()
    for (const r of withEvidence) {
      const o = replay(r, g)
      m.set(o, (m.get(o) ?? 0) + 1)
    }
    return m
  }
  const now = tally(CURRENT)
  const end = tally(SCENARIOS[SCENARIOS.length - 1]!)
  const outcomes: Outcome[] = ['SIPHON', 'probe-swings', 'slosh', 'below-floor',
                               'step-shaped', 'not-parked', 'other-branch']
  console.log(`\n  WHERE EVERY ROW LANDS`)
  console.log(`    ${pad('', 16)}${pad('current', 10)}proposed`)
  for (const o of outcomes) {
    console.log(`    ${pad(o, 16)}${pad(String(now.get(o) ?? 0), 10)}${end.get(o) ?? 0}`)
  }

  // ── the operator's real question: who would be shouting ──────────────────
  const final = results.get(SCENARIOS[SCENARIOS.length - 1]!.label) ?? []
  const perVehicle = new Map<string, { n: number; ml: number; steady: boolean }>()
  for (const r of final) {
    const e = perVehicle.get(r.vehicle) ?? { n: 0, ml: 0, steady: steady(r) }
    e.n++; e.ml += r.stolen_ml
    perVehicle.set(r.vehicle, e)
  }
  console.log(`\n  ALERTS BY VEHICLE under the full proposal — ${perVehicle.size} vehicles`)
  console.log(`    ${pad('VEHICLE', 26)}${pad('ALERTS', 8)}${pad('VOLUME', 10)}PROBE`)
  console.log('    ' + '─'.repeat(58))
  for (const [v, e] of [...perVehicle.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
    console.log(`    ${pad(v, 26)}${pad(String(e.n), 8)}${pad(L(e.ml), 10)}${e.steady ? 'trusted' : 'distrusted'}`)
  }

  // ── did we reproduce the eight hand-read cases? ──────────────────────────
  const KNOWN = ['FT 13', 'MTR 04', 'MTR 09', 'CTR 14', 'CTR 12', 'CTR 19', 'MTR 20']
  console.log(`\n  THE EIGHT HAND-READ CASES (23 Sep)`)
  for (const k of KNOWN) {
    const mine = withEvidence.filter(r => r.vehicle.includes(k) && r.detected.startsWith('23 Sep'))
    for (const r of mine) {
      const before = replay(r, CURRENT)
      const after  = replay(r, SCENARIOS[SCENARIOS.length - 1]!)
      console.log(`    ${pad(r.vehicle, 20)}${pad(r.detected, 14)}${pad(L(r.stolen_ml), 8)}` +
                  `${pad(before, 14)} -> ${after}`)
    }
  }

  console.log(`\n  NOTE  Every SIPHON count above is an UPPER BOUND: the SETTLING branch`)
  console.log(`        (kT / decayResidual) is not persisted and cannot be replayed, so`)
  console.log(`        parked falls that decay are counted here and would not be in life.\n`)

  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
