/**
 * How many drains in the ledger were judged against a filling nobody had checked?
 *
 * The mechanism, proven twice on 2026-09-23: a drain ripens at 20 minutes
 * (`SETTLE_MINUTES`) and a filling at 60 (`FILL_SETTLE_MINUTES +
 * FILL_HOLD_MINUTES`), `adjudicateDrain` cuts a drain's recovery window at any
 * filling not already ruled REDISTRIBUTION, and `adjudicatePendingDrains` only
 * ever selects PENDING rows — so the drain is judged first and never revisited.
 *
 * The signature is mechanical. What it MEANS is not, and the two readings are
 * opposites:
 *
 *   PROBE   the level went out and came back to where it started. The drain is
 *           false; the phantom-filling verdict is correct.
 *           (MUFINDI - FT 13: net -0.4 L, recovery completed on engine restart.)
 *   REAL    fuel genuinely left and was partly replaced. The drain is right and
 *           the FILLING is wrongly written off, because FILL_LOOKBEHIND_MINUTES
 *           reaches back across the drop and takes its baseline from before it.
 *           (MUFINDI: MTR 04: net -2.3 L, p90 parked swing 0.7 L.)
 *
 * This splits them on evidence rather than guessing: the NET level change across
 * the whole episode (baseline before the drain vs the settled level after the
 * filling), corroborated by the vehicle's own parked-swing profile — the same
 * measurement `probeSwings` uses for its trust gate.
 *
 * Read-only. One pass, no writes.
 *
 *   npx tsx prisma/truncation-sweep.ts --org=KASULU --days=30 --tunnel
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG    = arg('org') ?? 'KASULU'
const DAYS   = Number(arg('days') ?? 30)
const TUNNEL = process.argv.includes('--tunnel')

/** LOOKAHEAD_MS in fuel-adjudication.service — the recovery window. */
const LOOKAHEAD_HOURS = 3
/**
 * How close to its starting level the tank must return before the episode is
 * read as the instrument rather than as fuel.
 *
 * 15% of the claimed drain. A probe that wandered and came back lands within a
 * litre or two of where it started (FT 13: 0.4 L against a 19.4 L claim, 2%);
 * fuel that left and was partly replaced does not (MTR 04: 2.3 L against 19.1,
 * 12%) — though that one is close enough to the line to show the threshold is
 * doing real work and should not be treated as precise. Rows between 15% and
 * 50% are reported as UNCLEAR rather than forced into a bucket.
 */
const RETURNED_RATIO   = 0.15
const REAL_RATIO       = 0.50

function connectionString(): string {
  const u = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!)
  if (TUNNEL) { u.hostname = 'localhost'; u.port = '15432' }
  return u.toString()
}

const L = (ml: number | null): string => ml == null ? '—' : `${(ml / 1000).toFixed(1)} L`
const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

  // ── 1. every drain, with the filling that would have truncated it ────────
  const { rows } = await c.query(
    `SELECT t.id, v.name AS vehicle, v.id AS vehicle_id,
            to_char(t.detected_at + interval '3 hours', 'DD Mon HH24:MI') AS det_eat,
            t.stolen_ml, t.verdict, t.verdict_reason, t.drain_cause, t.recovered_ml,
            t.began_at, t.detected_at, t.verdict_at,
            f.id AS fill_id, f.filled_at, f.filled_ml,
            f.verdict AS fill_verdict, f.observed_rise_ml,
            EXTRACT(EPOCH FROM (f.verdict_at - t.verdict_at))/60 AS judged_gap_min
       FROM fuel_thefts t
       JOIN vehicles v      ON v.id = t.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN LATERAL (
         SELECT * FROM fuel_fillings ff
          WHERE ff.vehicle_id = t.vehicle_id
            AND ff.filled_at >= t.began_at
            AND ff.filled_at <= t.detected_at + interval '${LOOKAHEAD_HOURS} hours'
          ORDER BY ff.filled_at ASC LIMIT 1
       ) f ON true
      WHERE o.code = $1
        AND t.detected_at >= now() - interval '${DAYS} days'
      ORDER BY t.detected_at DESC`,
    [ORG],
  )

  const flagged = rows.filter((r: Record<string, unknown>) =>
    r['fill_id'] != null && r['verdict'] === 'DRAIN' &&
    r['fill_verdict'] === 'REDISTRIBUTION' &&
    r['judged_gap_min'] != null && Number(r['judged_gap_min']) > 0)

  // ── 2. net level change across each flagged episode ──────────────────────
  // Baseline: the last reading at or before the drain opened.
  // Settled:  the median of the half-hour starting an hour after the filling,
  //           by which point the pump has stopped and the tank has levelled.
  for (const r of flagged) {
    const { rows: [lv] } = await c.query(
      `SELECT
         (SELECT fuel_level_ml FROM vehicle_telemetries
           WHERE vehicle_id = $1 AND captured_at <= $2 AND fuel_level_ml IS NOT NULL
           ORDER BY captured_at DESC LIMIT 1) AS baseline_ml,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fuel_level_ml)
            FROM vehicle_telemetries
           WHERE vehicle_id = $1 AND fuel_level_ml IS NOT NULL
             AND captured_at >= $3::timestamp + interval '60 minutes'
             AND captured_at <= $3::timestamp + interval '90 minutes') AS settled_ml`,
      [r.vehicle_id, r.began_at, r.filled_at],
    )
    r.baseline_ml = lv?.baseline_ml ?? null
    r.settled_ml  = lv?.settled_ml  ?? null
    r.net_ml = (lv?.baseline_ml != null && lv?.settled_ml != null)
      ? Number(lv.settled_ml) - Number(lv.baseline_ml) : null
  }

  // ── 3. the parked-swing profile, for corroboration ───────────────────────
  const ids = [...new Set(flagged.map((r: { vehicle_id: string }) => r.vehicle_id))]
  const swings = new Map<string, { p90: number; swinging: number; windows: number }>()
  if (ids.length > 0) {
    const { rows: sw } = await c.query(
      `WITH parked AS (
         SELECT t.vehicle_id,
                date_trunc('hour', t.captured_at)
                  + interval '30 min' * floor(extract(minute from t.captured_at)/30) AS win,
                t.fuel_level_ml
           FROM vehicle_telemetries t
          WHERE t.vehicle_id = ANY($1)
            AND t.captured_at >= now() - interval '${DAYS} days'
            AND t.fuel_level_ml IS NOT NULL
            AND coalesce(t.speed_kmh, 0) = 0 AND t.engine_on = false
       ), spans AS (
         SELECT vehicle_id, win, max(fuel_level_ml) - min(fuel_level_ml) AS swing
           FROM parked GROUP BY vehicle_id, win HAVING count(*) >= 3
       )
       SELECT vehicle_id, count(*) AS windows,
              count(*) FILTER (WHERE swing >= 25000) AS swinging,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY swing) AS p90
         FROM spans GROUP BY vehicle_id`,
      [ids],
    )
    for (const s of sw) swings.set(s.vehicle_id, { p90: Number(s.p90), swinging: Number(s.swinging), windows: Number(s.windows) })
  }

  // ── 4. classify ──────────────────────────────────────────────────────────
  type Bucket = 'PROBE' | 'REAL' | 'UNCLEAR'
  const classify = (r: Record<string, unknown>): Bucket => {
    const net = r['net_ml'] as number | null
    const claim = Number(r['stolen_ml'])
    if (net == null || claim <= 0) return 'UNCLEAR'
    const back = Math.abs(net) / claim
    if (back <= RETURNED_RATIO) return 'PROBE'
    if (back >= REAL_RATIO)     return 'REAL'
    return 'UNCLEAR'
  }

  const buckets: Record<Bucket, Record<string, unknown>[]> = { PROBE: [], REAL: [], UNCLEAR: [] }
  for (const r of flagged) buckets[classify(r)].push(r)

  // ── report ───────────────────────────────────────────────────────────────
  const sum = (rs: Record<string, unknown>[], k: string): number =>
    rs.reduce((s, r) => s + Number(r[k] ?? 0), 0)

  console.log(`\n${'═'.repeat(84)}`)
  console.log(`  ${ORG} — truncation sweep · last ${DAYS} days`)
  console.log(`${'═'.repeat(84)}`)
  console.log(`\n  drains recorded                                   ${rows.length}`)
  console.log(`  …with a filling inside the recovery window        ${rows.filter((r: Record<string, unknown>) => r['fill_id'] != null).length}`)
  console.log(`  …settled as DRAIN                                 ${rows.filter((r: Record<string, unknown>) => r['verdict'] === 'DRAIN').length}`)
  console.log(`\n  JUDGED AGAINST A FILLING LATER DISOWNED           ${flagged.length}`)
  console.log(`    claimed volume on those rows                    ${L(sum(flagged, 'stolen_ml'))}`)
  console.log(`    fill volume written off alongside               ${L(sum(flagged, 'filled_ml'))}`)

  for (const [b, label] of [
    ['PROBE',   'the level RETURNED — drain is false, loss figure overstated'],
    ['REAL',    'fuel MOVED — drain is right, the delivery is wrongly written off'],
    ['UNCLEAR', 'between the two thresholds — needs a human'],
  ] as const) {
    const rs = buckets[b]
    console.log(`\n  ${'─'.repeat(80)}`)
    console.log(`  ${b} — ${rs.length} rows · ${label}`)
    console.log(`  ${'─'.repeat(80)}`)
    if (rs.length === 0) { console.log('    none'); continue }
    console.log(`    drain volume ${L(sum(rs, 'stolen_ml'))} · fill volume ${L(sum(rs, 'filled_ml'))}`)
    console.log(`\n    ${pad('UNIT', 26)}${pad('WHEN', 14)}${pad('DRAIN', 9)}${pad('FILL', 9)}${pad('NET', 9)}p90 swing`)
    for (const r of rs.slice(0, 14)) {
      const sw = swings.get(r['vehicle_id'] as string)
      console.log(`    ${pad(String(r['vehicle']), 26)}${pad(String(r['det_eat']), 14)}` +
                  `${pad(L(Number(r['stolen_ml'])), 9)}${pad(L(Number(r['filled_ml'])), 9)}` +
                  `${pad(r['net_ml'] == null ? '—' : L(Number(r['net_ml'])), 9)}` +
                  `${sw ? L(sw.p90) : '—'}`)
    }
    if (rs.length > 14) console.log(`    …and ${rs.length - 14} more`)
  }

  console.log(`\n  ${'═'.repeat(80)}`)
  console.log(`  LEDGER EFFECT`)
  console.log(`    overstated loss (PROBE rows counted as fuel gone)   ${L(sum(buckets.PROBE, 'stolen_ml'))}`)
  console.log(`    understated fuel-in (REAL rows' deliveries dropped) ${L(sum(buckets.REAL, 'filled_ml'))}`)
  console.log('')

  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
