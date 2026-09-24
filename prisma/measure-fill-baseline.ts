/**
 * What does shortening the filling baseline window actually change?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The claim
 *
 * `FILL_BASELINE_MINUTES` narrows the baseline from the whole 20-minute
 * lookbehind to the five minutes immediately before the pump, because the wide
 * window straddles any drain that just happened and reports the OLD level as
 * the tank's starting point.
 *
 * The fix is only worth having if it does not also manufacture deliveries. 307
 * of 5,794 fillings are REDISTRIBUTION because they are the up-swings of
 * oscillating probes, and a baseline that chases a trough would turn those into
 * corroborated refills — the exact failure this module exists to prevent. So
 * the question is not "does it fix the four known rows" but **"how many rows
 * flip, and are any of them on a probe that wanders?"**
 *
 * ## Approximation
 *
 * The medians here are computed in SQL over the RAW series, while
 * `adjudicateFilling` smooths with a 3-wide median first. Counts are therefore
 * close but not identical to what the sweep would write. Good enough to size
 * the change; not a substitute for the sweep itself.
 *
 *   npx tsx prisma/measure-fill-baseline.ts --org=KASULU --days=30 --tunnel
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const ORG    = arg('org') ?? 'KASULU'
const DAYS   = Number(arg('days') ?? 30)
const TUNNEL = process.argv.includes('--tunnel')

/** Mirrors the shipped constants. */
const FILL_OBSERVED_MIN_RATIO = 0.5
const MIN_SAMPLES = 3

function connectionString(): string {
  const u = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!)
  if (TUNNEL) { u.hostname = 'localhost'; u.port = '15432' }
  return u.toString()
}

interface Row {
  vehicle: string; filled: string; filled_ml: number
  verdict: string; stored_rise: number | null
  wide_baseline: number | null; recent_baseline: number | null
  recent_n: number; settled: number | null; after_n: number
  capped_baseline: number | null; capped_n: number; initial_fuel_level_ml: number | null
  before_n: number
  swinging: number | null; windows: number | null
}

const verdictOf = (rise: number | null, claimMl: number): string => {
  if (rise == null) return 'no-evidence'
  return claimMl > 0 && rise >= claimMl * FILL_OBSERVED_MIN_RATIO ? 'REFILL' : 'REDISTRIBUTION'
}

const probeSwings = (r: Row): boolean =>
  (r.swinging ?? 0) >= 3 && (r.windows ?? 0) > 0 && (r.swinging ?? 0) / (r.windows ?? 1) >= 0.05

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
const L = (ml: number | null): string => ml == null ? '—' : `${(ml / 1000).toFixed(1)} L`

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
       SELECT vehicle_id, count(*) AS windows,
              count(*) FILTER (WHERE swing >= 25000) AS swinging
         FROM spans GROUP BY vehicle_id
     )
     SELECT v.name AS vehicle,
            to_char(f.filled_at + interval '3 hours', 'DD Mon HH24:MI') AS filled,
            f.filled_ml, f.verdict, f.observed_rise_ml AS stored_rise,
            w.med AS wide_baseline, w.n AS before_n,
            r.med AS recent_baseline, r.n AS recent_n,
            cap.med AS capped_baseline, cap.n AS capped_n, f.initial_fuel_level_ml,
            a.med AS settled, a.n AS after_n,
            prof.swinging, prof.windows
       FROM fuel_fillings f
       JOIN vehicles v      ON v.id = f.vehicle_id
       JOIN organisations o ON o.id = v.organisation_id
       LEFT JOIN prof       ON prof.vehicle_id = f.vehicle_id
       LEFT JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fuel_level_ml) AS med, count(*) AS n
           FROM vehicle_telemetries t
          WHERE t.vehicle_id = f.vehicle_id AND t.fuel_level_ml IS NOT NULL
            AND t.captured_at >= f.filled_at - interval '20 minutes'
            AND t.captured_at <= f.filled_at) w ON true
       LEFT JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fuel_level_ml) AS med, count(*) AS n
           FROM vehicle_telemetries t
          WHERE t.vehicle_id = f.vehicle_id AND t.fuel_level_ml IS NOT NULL
            AND t.captured_at >= f.filled_at - interval '5 minutes'
            AND t.captured_at <= f.filled_at) r ON true
       LEFT JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fuel_level_ml) AS med, count(*) AS n
           FROM vehicle_telemetries t
          WHERE t.vehicle_id = f.vehicle_id AND t.fuel_level_ml IS NOT NULL
            AND t.captured_at >= f.filled_at + interval '20 minutes'
            AND t.captured_at <= f.filled_at + interval '60 minutes') a ON true
       -- Variant C: the same 20-minute window, but only the readings that
       -- describe the tank AS IT NOW STANDS. Anything above the provider's own
       -- stated pre-fill level is fuel that has since gone, so it cannot be the
       -- baseline a delivery is measured from.
       LEFT JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fuel_level_ml) AS med, count(*) AS n
           FROM vehicle_telemetries t
          WHERE t.vehicle_id = f.vehicle_id AND t.fuel_level_ml IS NOT NULL
            AND t.captured_at >= f.filled_at - interval '20 minutes'
            AND t.captured_at <= f.filled_at
            AND f.initial_fuel_level_ml IS NOT NULL
            AND t.fuel_level_ml <= f.initial_fuel_level_ml + 2000) cap ON true
      WHERE o.code = $1 AND f.filled_at >= now() - interval '${DAYS} days'
      ORDER BY f.filled_at`,
    [ORG],
  )

  const decidable = rows.filter(r =>
    Number(r.before_n) >= MIN_SAMPLES && Number(r.after_n) >= MIN_SAMPLES &&
    r.wide_baseline != null && r.settled != null)

  // Variant B = the 5-minute window already implemented. Variant C = the
  // level-capped window added here. Both are measured against today.
  const score = (pick: (r: Row) => number | null) => {
    let toRefill = 0, toRedist = 0, same = 0, swingyRefill = 0, steadyRefill = 0
    for (const r of decidable) {
      const oldRise = Number(r.settled) - Number(r.wide_baseline)
      const base = pick(r)
      const newRise = Number(r.settled) - Number(base ?? r.wide_baseline)
      const before = verdictOf(oldRise, r.filled_ml)
      const after  = verdictOf(newRise, r.filled_ml)
      if (before === after) { same++; continue }
      if (after === 'REFILL') {
        toRefill++
        if (probeSwings(r)) swingyRefill++; else steadyRefill++
      } else toRedist++
    }
    return { toRefill, toRedist, same, swingyRefill, steadyRefill }
  }
  const B = score(r => Number(r.recent_n) >= MIN_SAMPLES ? r.recent_baseline : r.wide_baseline)
  const C = score(r => Number(r.capped_n) >= MIN_SAMPLES ? r.capped_baseline : r.wide_baseline)
  console.log(`\n  VARIANT COMPARISON (decidable ${decidable.length})`)
  console.log(`    ${pad('', 26)}${pad('->REFILL', 11)}${pad('->REDIST', 11)}${pad('on trusted', 12)}on wandering`)
  console.log(`    B  5-minute window       ${pad(String(B.toRefill), 11)}${pad(String(B.toRedist), 11)}${pad(String(B.steadyRefill), 12)}${B.swingyRefill}`)
  console.log(`    C  capped at pre-fill    ${pad(String(C.toRefill), 11)}${pad(String(C.toRedist), 11)}${pad(String(C.steadyRefill), 12)}${C.swingyRefill}`)

  let flipToRefill = 0, flipToRedist = 0, unchanged = 0
  const flips: Array<{ r: Row; before: string; after: string; oldRise: number; newRise: number }> = []

  for (const r of decidable) {
    const useRecent = Number(r.recent_n) >= MIN_SAMPLES && r.recent_baseline != null
    const oldRise = Number(r.settled) - Number(r.wide_baseline)
    const newRise = Number(r.settled) - Number(useRecent ? r.recent_baseline : r.wide_baseline)
    const before = verdictOf(oldRise, r.filled_ml)
    const after  = verdictOf(newRise, r.filled_ml)
    if (before === after) { unchanged++; continue }
    if (after === 'REFILL') flipToRefill++; else flipToRedist++
    flips.push({ r, before, after, oldRise, newRise })
  }

  console.log(`\n${'═'.repeat(80)}`)
  console.log(`  ${ORG} — filling baseline window · ${rows.length} fillings · ${DAYS} days`)
  console.log(`${'═'.repeat(80)}`)
  console.log(`  decidable (enough readings either side)   ${decidable.length}`)
  console.log(`  verdict unchanged                         ${unchanged}`)
  console.log(`  REDISTRIBUTION -> REFILL                  ${flipToRefill}`)
  console.log(`  REFILL -> REDISTRIBUTION                  ${flipToRedist}`)

  const onSwingy = flips.filter(f => f.after === 'REFILL' && probeSwings(f.r))
  const onSteady = flips.filter(f => f.after === 'REFILL' && !probeSwings(f.r))
  console.log(`\n  OF THE ROWS THAT BECOME REFILL`)
  console.log(`    on probes the trust gate TRUSTS         ${onSteady.length}`)
  console.log(`    on probes that WANDER                   ${onSwingy.length}   <- the false-positive risk`)
  const recovered = flips.filter(f => f.after === 'REFILL').reduce((s, f) => s + f.r.filled_ml, 0)
  console.log(`    delivery volume restored to fuel-in     ${L(recovered)}`)

  console.log(`\n  FLIPS (first 25)`)
  console.log(`    ${pad('VEHICLE', 24)}${pad('WHEN', 14)}${pad('CLAIM', 9)}${pad('OLD RISE', 10)}${pad('NEW RISE', 10)}PROBE`)
  console.log('    ' + '─'.repeat(74))
  for (const f of flips.slice(0, 25)) {
    console.log(`    ${pad(f.r.vehicle, 24)}${pad(f.r.filled, 14)}${pad(L(f.r.filled_ml), 9)}` +
                `${pad(L(f.oldRise), 10)}${pad(L(f.newRise), 10)}` +
                `${probeSwings(f.r) ? 'wanders' : 'trusted'}  ${f.before} -> ${f.after}`)
  }
  if (flips.length > 25) console.log(`    …and ${flips.length - 25} more`)

  // The four rows the change exists for.
  console.log(`\n  THE FOUR KNOWN ROWS (23 Sep)`)
  for (const name of ['MTR 09', 'FT 13', 'MTR 04', 'CTR 14']) {
    for (const r of decidable.filter(x => x.vehicle.includes(name) && x.filled.startsWith('23 Sep'))) {
      const useRecent = Number(r.recent_n) >= MIN_SAMPLES && r.recent_baseline != null
      const oldRise = Number(r.settled) - Number(r.wide_baseline)
      const newRise = Number(r.settled) - Number(useRecent ? r.recent_baseline : r.wide_baseline)
      console.log(`    ${pad(r.vehicle, 22)}${pad(r.filled, 14)}claim ${pad(L(r.filled_ml), 9)}` +
                  `stored ${pad(L(r.stored_rise), 9)}old ${pad(L(oldRise), 9)}new ${pad(L(newRise), 9)}` +
                  `${verdictOf(oldRise, r.filled_ml)} -> ${verdictOf(newRise, r.filled_ml)}`)
    }
  }
  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
