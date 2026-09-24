/**
 * The level series around one drain, rendered in the operator's own clock.
 *
 * Timestamps are formatted IN SQL (`to_char`) rather than through a JS Date.
 * `DateTime` maps to `timestamp` WITHOUT time zone and holds UTC, so node-pg
 * parses it in the process's local zone — on a Nairobi machine that silently
 * re-labels a UTC reading as EAT and the error is invisible, because both are
 * plausible times of day.
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const VEHICLE = arg('vehicle') ?? 'cms21vqe40013agv7qingatil'
/** Window bounds as STORED (UTC wall-clock). */
const FROM = arg('from') ?? '2026-09-23 09:30:00'
const TO   = arg('to')   ?? '2026-09-23 10:25:00'

function connectionString(): string {
  const u = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!)
  u.hostname = 'localhost'; u.port = '15432'
  return u.toString()
}

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

  // A plate is easier to type than a cuid, and the id is what every query
  // below needs — resolve it once here rather than making the caller look it up.
  let vehicleId = VEHICLE
  const plate = arg('plate')
  if (plate) {
    const { rows: vs } = await c.query(
      `SELECT id, name FROM vehicles WHERE name ILIKE $1 OR registration_plate ILIKE $1 LIMIT 1`,
      [`%${plate.replace(/^MUFINDI\s*[-:]?\s*/i, '')}%`],
    )
    if (vs.length === 0) { console.log(`No vehicle matching "${plate}"`); await c.end(); return }
    vehicleId = vs[0].id
    console.log(`\n${vs[0].name}  (${vehicleId})`)
  }

  const { rows } = await c.query(
    `SELECT to_char(t.captured_at + interval '3 hours', 'HH24:MI:SS') AS eat,
            t.fuel_level_ml, t.engine_on, t.speed_kmh,
            (r.payload->>'ignition_known')::boolean AS ignition_known,
            r.payload->>'engine_hours' AS engine_hours
       FROM vehicle_telemetries t
       LEFT JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
      WHERE t.vehicle_id = $1
        AND t.captured_at >= $2::timestamp AND t.captured_at <= $3::timestamp
        AND t.fuel_level_ml IS NOT NULL
      ORDER BY t.captured_at`,
    [vehicleId, FROM, TO],
  )

  console.log(`=== ${rows.length} readings, ${FROM} - ${TO} UTC (shown in EAT) ===`)
  console.log('  EAT        level     delta   ign   engine  speed')
  let prev: number | null = null
  for (const s of rows) {
    const d = prev == null ? '' : ((s.fuel_level_ml - prev) / 1000)
    const delta = d === '' ? '      ' : (d === 0 ? '     ·' : d.toFixed(2).padStart(6))
    const ign = s.ignition_known === true ? 'MEAS' : s.ignition_known === false ? 'meas' : ' -- '
    console.log(
      `  ${s.eat}  ${(s.fuel_level_ml / 1000).toFixed(1).padStart(6)} L  ${delta}  ${ign}  ` +
      `${(s.engine_on ? 'ON ' : 'off').padStart(4)}  ${String(s.speed_kmh ?? '-').padStart(3)} km/h`,
    )
    prev = s.fuel_level_ml
  }

  // How much MEASURED ignition this vehicle carries at all — `engineEvidence: 0`
  // on the drain says none inside the fall, which is what sent the cause to
  // `engine-state-unknown` instead of the parked branch.
  const { rows: [cov] } = await c.query(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE (r.payload->>'ignition_known')::boolean IS NOT NULL) AS with_ign,
            count(*) FILTER (WHERE (r.payload->>'ignition_known')::boolean = true) AS ign_true
       FROM vehicle_telemetries t
       LEFT JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
      WHERE t.vehicle_id = $1 AND t.captured_at >= now() - interval '2 days'`,
    [vehicleId],
  )
  console.log(`\n=== ignition coverage, last 2 days ===`)
  console.log(`  ${cov.with_ign} of ${cov.total} readings carry a measured ignition (${cov.ign_true} true)`)

  const { rows: notes } = await c.query(
    `SELECT to_char(occurred_at + interval '3 hours', 'HH24:MI:SS') AS eat,
            severity, source, alert_type, text
       FROM notifications
      WHERE vehicle_id = $1 AND occurred_at >= $2::timestamp - interval '2 hours'
        AND occurred_at <= $3::timestamp + interval '4 hours'
      ORDER BY occurred_at`,
    [vehicleId, FROM, TO],
  )
  console.log(`\n=== notifications in the surrounding window — ${notes.length} ===`)
  for (const n of notes) console.log(`  ${n.eat} [${n.severity}] ${n.source}/${n.alert_type ?? '-'}: ${n.text}`)

  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
