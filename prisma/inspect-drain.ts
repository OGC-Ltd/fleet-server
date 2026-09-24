/**
 * One-off: dump everything the fuel pipeline recorded for a single vehicle on a
 * single day, so a disputed verdict can be read back against the evidence it
 * was actually reached on.
 *
 * Prints the `fuel_thefts` rows with their `drop_evidence`, the `fuel_fillings`
 * rows that sit in the same window (which is what truncates a drain's recovery
 * test — see fuel-adjudication.service.ts's `verdict: { not: 'REDISTRIBUTION' }`
 * filter), the raw level series, and any notification published for either.
 *
 * Usage:
 *   npx tsx prisma/inspect-drain.ts --plate="MUFINDI - FT 13" --date=2026-09-23
 *
 * Add --tunnel to rewrite the host in DIRECT_URL to localhost:15432, for a dev
 * machine reaching the private RDS through the SSH tunnel (see guide.md). The
 * credential is never printed or altered — only the host:port.
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const PLATE = arg('plate') ?? 'MUFINDI - FT 13'
const DATE  = arg('date') ?? '2026-09-23'
const TZ    = 'Africa/Nairobi'
const TUNNEL = process.argv.includes('--tunnel')

function connectionString(): string {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('DIRECT_URL / DATABASE_URL not set')
  if (!TUNNEL) return url
  // Swap ONLY the host:port. Everything else — user, password, database,
  // query string — is carried through untouched.
  const u = new URL(url)
  u.hostname = 'localhost'
  u.port = '15432'
  return u.toString()
}

const fmt = (d: Date | null): string =>
  d == null ? '—' : d.toLocaleString('en-GB', { timeZone: TZ, hour12: false })

const L = (ml: number | null): string =>
  ml == null ? '—' : `${(ml / 1000).toFixed(1)} L`

async function main() {
  const client = new Client({ connectionString: connectionString() })
  await client.connect()

  // ── the vehicle ──────────────────────────────────────────────────────────
  const { rows: vehicles } = await client.query(
    `SELECT v.id, v.name, v.registration_plate, v.vehicle_type,
            v.tank_capacity_litres, o.code AS org_code
       FROM vehicles v
       JOIN organisations o ON o.id = v.organisation_id
      WHERE v.name ILIKE $1 OR v.registration_plate ILIKE $1`,
    [`%${PLATE.replace(/^MUFINDI\s*[-:]\s*/i, '')}%`],
  )
  if (vehicles.length === 0) {
    console.log(`No vehicle matching ${PLATE}`)
    await client.end(); return
  }
  console.log('=== VEHICLE ===')
  for (const v of vehicles) {
    console.log(`  ${v.org_code}  ${v.name}  plate=${v.registration_plate}  ` +
                `type=${v.vehicle_type}  tank=${v.tank_capacity_litres ?? '—'} L  id=${v.id}`)
  }
  const vehicle = vehicles[0]

  const from = `${DATE} 00:00:00`
  const to   = `${DATE} 23:59:59`

  // ── drains ───────────────────────────────────────────────────────────────
  const { rows: drains } = await client.query(
    `SELECT id, began_at, detected_at, stolen_ml,
            initial_fuel_level_ml, final_fuel_level_ml,
            initial_speed_kmh, final_speed_kmh,
            verdict, verdict_reason, verdict_confidence, verdict_at, recovered_ml,
            drain_cause, cause_reason, cause_confidence,
            fall_seconds, measured_drop_ml, engine_seconds, engine_evidence,
            step_fraction, implied_lph, fall_distance_km
       FROM fuel_thefts
      WHERE vehicle_id = $1
        AND detected_at >= ($2::timestamp AT TIME ZONE $4)
        AND detected_at <= ($3::timestamp AT TIME ZONE $4)
      ORDER BY detected_at`,
    [vehicle.id, from, to, TZ],
  )
  console.log(`\n=== DRAINS (fuel_thefts) — ${drains.length} ===`)
  for (const d of drains) {
    console.log(`\n  began   ${fmt(d.began_at)}   detected ${fmt(d.detected_at)}`)
    console.log(`  claimed ${L(d.stolen_ml)}   ${L(d.initial_fuel_level_ml)} -> ${L(d.final_fuel_level_ml)}`)
    console.log(`  verdict ${d.verdict}  reason=${d.verdict_reason ?? '—'}  ` +
                `confidence=${d.verdict_confidence ?? '—'}  recovered=${L(d.recovered_ml)}`)
    console.log(`  cause   ${d.drain_cause ?? '—'}  reason=${d.cause_reason ?? '—'}  ` +
                `confidence=${d.cause_confidence ?? '—'}   judged ${fmt(d.verdict_at)}`)
    console.log(`  speed   ${d.initial_speed_kmh ?? '—'} -> ${d.final_speed_kmh ?? '—'} km/h`)
    console.log(`  EVIDENCE fallSeconds=${d.fall_seconds ?? '—'}  measuredDrop=${L(d.measured_drop_ml)}  ` +
                `engineSeconds=${d.engine_seconds ?? '—'}  engineEvidence=${d.engine_evidence ?? '—'}`)
    console.log(`           stepFraction=${d.step_fraction ?? '—'}  impliedLph=${d.implied_lph ?? '—'}  ` +
                `fallDistanceKm=${d.fall_distance_km ?? '—'}`)
    if (d.fall_seconds != null && d.measured_drop_ml != null && d.fall_seconds > 0) {
      console.log(`           wallLph=${((d.measured_drop_ml / 1000) / (d.fall_seconds / 3600)).toFixed(1)} ` +
                  `(SIPHON_MIN_LPH=5, MAX_PLAUSIBLE_REMOVAL_LPH=300)`)
    }
    console.log(`  id      ${d.id}`)
  }

  // ── fillings ─────────────────────────────────────────────────────────────
  const { rows: fills } = await client.query(
    `SELECT id, filled_at, filled_ml, initial_fuel_level_ml, final_fuel_level_ml,
            verdict, verdict_reason, verdict_confidence, verdict_at, observed_rise_ml
       FROM fuel_fillings
      WHERE vehicle_id = $1
        AND filled_at >= ($2::timestamp AT TIME ZONE $4)
        AND filled_at <= ($3::timestamp AT TIME ZONE $4)
      ORDER BY filled_at`,
    [vehicle.id, from, to, TZ],
  )
  console.log(`\n=== FILLINGS (fuel_fillings) — ${fills.length} ===`)
  for (const f of fills) {
    console.log(`\n  filled  ${fmt(f.filled_at)}   claimed ${L(f.filled_ml)}   ` +
                `${L(f.initial_fuel_level_ml)} -> ${L(f.final_fuel_level_ml)}`)
    console.log(`  verdict ${f.verdict}  reason=${f.verdict_reason ?? '—'}  ` +
                `confidence=${f.verdict_confidence ?? '—'}  observedRise=${L(f.observed_rise_ml)}`)
    console.log(`  judged  ${fmt(f.verdict_at)}   id=${f.id}`)
  }

  // ── the level series ─────────────────────────────────────────────────────
  // The window adjudication itself reads: beganAt - 30 min .. detectedAt + 3 h.
  const { rows: series } = await client.query(
    `SELECT t.captured_at, t.fuel_level_ml, t.engine_on, t.speed_kmh,
            (r.payload->>'ignition_known')::boolean AS ignition_known
       FROM vehicle_telemetries t
       LEFT JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
      WHERE t.vehicle_id = $1
        AND t.captured_at >= ($2::timestamp AT TIME ZONE $4)
        AND t.captured_at <= ($3::timestamp AT TIME ZONE $4)
        AND t.fuel_level_ml IS NOT NULL
      ORDER BY t.captured_at`,
    [vehicle.id, `${DATE} 11:45:00`, `${DATE} 14:15:00`, TZ],
  )
  console.log(`\n=== LEVEL SERIES 11:45-14:15 ${TZ} — ${series.length} readings ===`)
  let prev: number | null = null
  for (const s of series) {
    const delta = prev == null ? '' : `  Δ${((s.fuel_level_ml - prev) / 1000).toFixed(2)}`
    const ign = s.ignition_known === true ? (s.engine_on ? 'ENGINE_ON ' : 'engine_off')
              : `(${s.engine_on ? 'on' : 'off'} inferred)`
    console.log(`  ${fmt(s.captured_at)}  ${String((s.fuel_level_ml / 1000).toFixed(1)).padStart(7)} L` +
                `${delta.padStart(10)}  ${ign}  ${s.speed_kmh ?? '—'} km/h`)
    prev = s.fuel_level_ml
  }

  // ── what reached the operator ────────────────────────────────────────────
  const { rows: notes } = await client.query(
    `SELECT created_at, occurred_at, source, alert_type, severity, text
       FROM notifications
      WHERE vehicle_id = $1
        AND created_at >= ($2::timestamp AT TIME ZONE $4)
        AND created_at <= ($3::timestamp AT TIME ZONE $4)
      ORDER BY created_at`,
    [vehicle.id, from, to, TZ],
  )
  console.log(`\n=== NOTIFICATIONS — ${notes.length} ===`)
  for (const n of notes) {
    console.log(`  occurred ${fmt(n.occurred_at)}  published ${fmt(n.created_at)}  ` +
                `[${n.severity}] ${n.source}/${n.alert_type ?? '—'}`)
    console.log(`      ${n.text}`)
  }

  await client.end()
}

main().catch((err) => { console.error(err); process.exit(1) })
