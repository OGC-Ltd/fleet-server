/**
 * Is this probe an oscillator, or did something actually happen?
 *
 * The question a single event cannot answer. A level that falls and returns is
 * ambiguous on its own: it is either fuel moving (out, then back in) or an
 * instrument misreading. What separates them is the vehicle's OWN history —
 * a probe that does this routinely is an instrument, a probe that has done it
 * once has probably witnessed something.
 *
 * Prints, over the window: every filling and every drain, the routine refuel
 * pattern (size, time of day, spacing), and the parked-swing profile the
 * classifier's own trust gate is built on (`probeSwings`, SWING_ML 25 L).
 *
 * Read-only.
 *
 *   npx tsx prisma/probe-behaviour.ts --plate="MTR 04" --days=30 --tunnel
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const PLATES = (arg('plate') ?? 'MTR 04').split(',').map(s => s.trim())
const DAYS   = Number(arg('days') ?? 30)
const TUNNEL = process.argv.includes('--tunnel')

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

  for (const plate of PLATES) {
    const { rows: vs } = await c.query(
      `SELECT id, name, tank_capacity_litres FROM vehicles
        WHERE name ILIKE $1 OR registration_plate ILIKE $1 LIMIT 1`,
      [`%${plate.replace(/^MUFINDI\s*[-:]?\s*/i, '')}%`],
    )
    if (vs.length === 0) { console.log(`\nNo vehicle matching "${plate}"`); continue }
    const v = vs[0]

    console.log(`\n${'═'.repeat(78)}`)
    console.log(`  ${v.name}   tank ${v.tank_capacity_litres ?? '—'} L   ·   last ${DAYS} days`)
    console.log(`${'═'.repeat(78)}`)

    // ── refuelling history: is a ~17 L fill at this hour routine? ──
    const { rows: fills } = await c.query(
      `SELECT to_char(filled_at + interval '3 hours', 'DD Mon HH24:MI') AS eat,
              filled_ml, initial_fuel_level_ml, final_fuel_level_ml,
              verdict, verdict_reason, observed_rise_ml
         FROM fuel_fillings
        WHERE vehicle_id = $1 AND filled_at >= now() - interval '${DAYS} days'
        ORDER BY filled_at DESC`,
      [v.id],
    )
    console.log(`\n  FILLINGS — ${fills.length}`)
    for (const f of fills) {
      console.log(`    ${pad(f.eat, 14)} ${pad(L(f.filled_ml), 9)} ` +
                  `${pad(L(f.initial_fuel_level_ml) + ' -> ' + L(f.final_fuel_level_ml), 22)} ` +
                  `${pad(f.verdict, 16)} ${f.verdict_reason ?? '—'}  observed ${L(f.observed_rise_ml)}`)
    }
    const real = fills.filter((f: { verdict: string }) => f.verdict === 'level-rose' || f.verdict === 'REFILL')
    console.log(`    ${fills.filter((f: {verdict:string}) => f.verdict === 'REDISTRIBUTION').length} ruled REDISTRIBUTION (phantom) · ${real.length} corroborated`)

    // ── drains ──
    const { rows: drains } = await c.query(
      `SELECT to_char(detected_at + interval '3 hours', 'DD Mon HH24:MI') AS eat,
              stolen_ml, verdict, verdict_reason, drain_cause, step_fraction, fall_seconds
         FROM fuel_thefts
        WHERE vehicle_id = $1 AND detected_at >= now() - interval '${DAYS} days'
        ORDER BY detected_at DESC`,
      [v.id],
    )
    console.log(`\n  DRAINS — ${drains.length}`)
    for (const d of drains) {
      console.log(`    ${pad(d.eat, 14)} ${pad(L(d.stolen_ml), 9)} ${pad(d.verdict, 16)} ` +
                  `${pad(d.verdict_reason ?? '—', 20)} ${pad(d.drain_cause ?? '—', 15)} ` +
                  `step ${d.step_fraction?.toFixed?.(2) ?? '—'} fall ${d.fall_seconds ?? '—'}s`)
    }

    // ── the parked-swing profile: the trust gate's own input ──
    // Half-hour windows with the engine measured OFF and no movement; how far
    // the level travelled inside each. SWING_ML is 25 L in the classifier.
    const { rows: [swing] } = await c.query(
      `WITH parked AS (
         SELECT date_trunc('hour', t.captured_at)
                  + interval '30 min' * floor(extract(minute from t.captured_at)/30) AS win,
                t.fuel_level_ml
           FROM vehicle_telemetries t
           LEFT JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
          WHERE t.vehicle_id = $1
            AND t.captured_at >= now() - interval '${DAYS} days'
            AND t.fuel_level_ml IS NOT NULL
            AND coalesce(t.speed_kmh, 0) = 0
            AND t.engine_on = false
            AND (r.payload->>'ignition_known')::boolean = true
       ), spans AS (
         SELECT win, max(fuel_level_ml) - min(fuel_level_ml) AS swing, count(*) AS n
           FROM parked GROUP BY win HAVING count(*) >= 3
       )
       SELECT count(*) AS windows,
              count(*) FILTER (WHERE swing >= 25000) AS swinging,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY swing)) AS p50,
              round(percentile_cont(0.9) WITHIN GROUP (ORDER BY swing)) AS p90,
              max(swing) AS worst
         FROM spans`,
      [v.id],
    )
    const pct = Number(swing.windows) > 0
      ? ((Number(swing.swinging) / Number(swing.windows)) * 100).toFixed(1) : '—'
    console.log(`\n  PARKED-SWING PROFILE  (engine measured OFF, stationary, 30-min windows)`)
    console.log(`    windows ${swing.windows} · swinging >=25 L: ${swing.swinging} (${pct}%)`)
    console.log(`    swing p50 ${L(Number(swing.p50))} · p90 ${L(Number(swing.p90))} · worst ${L(Number(swing.worst))}`)
    console.log(`    classifier distrusts a probe at >=3 swinging windows AND >=5% share`)
  }

  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
