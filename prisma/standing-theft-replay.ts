/**
 * READ-ONLY replay of the standing-fall call (modules/fuel/standing-theft) over
 * the stored ledger: for every drain that stayed down, read the same evidence
 * window `judgeDrain` reads and ask whether the call would have been made.
 * Prints the calls it finds; writes nothing.
 *
 *   node prisma/signal-alerts.build.mjs prisma/standing-theft-replay.ts standing-replay.cjs
 *   NODE_PATH=~/prod/fleet-server/node_modules node standing-replay.cjs [days]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import pg from 'pg'
import { standingTheft } from '../src/modules/fuel/standing-theft.js'
import type { FallReading } from '../src/modules/fuel/parked-fall.js'

const FUEL_RATE_DOWN = ['burn-above-class-ceiling', 'burn-far-above-band', 'drop-while-stationary', 'drop-exceeds-distance']
const LOOKBEHIND_MS = 30 * 60_000
const LOOKAHEAD_MS = 3 * 60 * 60_000
const days = Number(process.argv[2] ?? 30)

pg.types.setTypeParser(1114, s => new Date(s.replace(' ', 'T') + 'Z'))
const ts = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')
const EAT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

async function main() {
  const env = dotenv.parse(fs.readFileSync(path.join(os.homedir(), 'prod/fleet-server/.env')))
  const c = new pg.Client({ connectionString: env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  if ((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('not read-only')
  await c.query("SET statement_timeout = '90s'")

  const from = new Date(Date.now() - days * 86_400_000)
  const drains = (await c.query(`
    SELECT t.id, t.vehicle_id, v.registration_plate AS plate, o.name AS org, v.tank_capacity_litres AS tank, v.vehicle_type AS vtype,
           t.began_at, t.detected_at, t.fall_seconds, t.stolen_ml, t.drain_cause::text AS cause,
           t.cause_reason AS reason, t.verdict_reason, t.review_status::text AS review, t.dismissed_at
      FROM fuel_thefts t JOIN vehicles v ON v.id = t.vehicle_id JOIN organisations o ON o.id = v.organisation_id
     WHERE t.began_at >= $1::timestamp AND t.verdict::text = 'DRAIN'
       AND coalesce(t.drain_cause::text, '') NOT IN ('SIPHON', 'SLOSH')
       AND coalesce(t.cause_reason, '') NOT IN ('probe-swings', 'probe-overreads') AND coalesce(t.verdict_reason, '') <> 'probe-swings'
       AND greatest(coalesce(t.measured_drop_ml, 0), t.stolen_ml) >= 5000
     ORDER BY t.began_at`, [ts(from)])).rows

  let noRows = 0
  const calls: Array<{ d: typeof drains[number]; s: NonNullable<ReturnType<typeof standingTheft>> }> = []
  const t0 = Date.now()
  for (const d of drains) {
    const rows = (await c.query(`
      SELECT t.captured_at, t.fuel_level_ml, t.engine_on, t.speed_kmh,
             (r.payload->>'ignition_known')::boolean AS ignition_known,
             t.lat, t.lng, t.engine_hours_meter, t.accel_x_g, t.accel_y_g, t.accel_z_g
        FROM vehicle_telemetries t
        JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
       WHERE t.vehicle_id = $1 AND t.captured_at >= $2::timestamp AND t.captured_at <= $3::timestamp
         AND t.fuel_level_ml IS NOT NULL
       ORDER BY t.captured_at ASC`,
      [d.vehicle_id, ts(new Date(d.began_at.getTime() - LOOKBEHIND_MS)), ts(new Date(d.detected_at.getTime() + LOOKAHEAD_MS))])).rows
    if (rows.length === 0) { noRows++; continue }
    const readings: FallReading[] = rows.map(r => ({
      t: r.captured_at.getTime(), fuelMl: r.fuel_level_ml, speedKmh: r.speed_kmh, engineOn: r.engine_on,
      ignitionKnown: r.ignition_known === true, meterH: r.engine_hours_meter, lat: r.lat, lng: r.lng,
      accel: r.accel_x_g == null && r.accel_y_g == null && r.accel_z_g == null ? null : { x: r.accel_x_g, y: r.accel_y_g, z: r.accel_z_g },
    }))
    const began = d.began_at.getTime()
    const s = standingTheft(readings, {
      spanFrom: began,
      spanTo: Math.max(d.detected_at.getTime(), began + 10 * 60_000, began + (d.fall_seconds ?? 0) * 1000),
      tankCapacityL: d.tank,
    })
    if (s) calls.push({ d, s })
  }
  await c.end()

  // The provider files some dips twice: one call per vehicle and fall.
  const uniq = new Map<string, typeof calls[number]>()
  for (const k of calls) uniq.set(`${k.d.vehicle_id}|${k.s.fromT}`, k)
  const u = [...uniq.values()]
  const org = (o: string) => o.split(' ')[0]
  console.log(`${days} days: ${drains.length} drains read in ${Math.round((Date.now() - t0) / 1000)} s (${noRows} with no evidence rows)`)
  console.log(`calls: ${u.length} (${(u.length / days).toFixed(2)}/day) — after-refuel ${u.filter(k => k.s.rule === 'fell-after-refuel').length}, standing ${u.filter(k => k.s.rule === 'fell-while-standing').length}; engine off ${u.filter(k => k.s.engine === 'off').length}, idling-still ${u.filter(k => k.s.engine === 'idling-still').length}`)
  const tally = (f: (k: typeof u[number]) => string) => JSON.stringify(Object.entries(u.reduce<Record<string, number>>((m, k) => { m[f(k)] = (m[f(k)] ?? 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1]))
  console.log('by org:', tally(k => org(k.d.org)))
  console.log('by stored cause:', tally(k => `${k.d.cause ?? '-'}/${k.d.reason ?? '-'}`))
  console.log('old scope (FUEL RATE/DOWN or after a refuel):', u.filter(k => k.s.rule === 'fell-after-refuel' || (k.d.cause === 'UNEXPLAINED_BURN' && FUEL_RATE_DOWN.includes(k.d.reason))).length)
  for (const f of [5, 7.5, 10, 12.5, 15]) console.log(`standing calls with fall >= ${f} L: ${u.filter(k => k.s.rule === 'fell-while-standing' && k.s.fallMl >= f * 1000).length}`)
  console.log('by unit type:', tally(k => k.d.vtype ?? '-'))
  for (const { d, s } of u.sort((a, b) => b.s.fromT - a.s.fromT)) {
    console.log([
      EAT.format(s.fromT), org(d.org), d.plate, `${d.cause ?? '-'}/${d.reason ?? '-'}`, s.rule, s.engine,
      `${(s.beforeMl / 1000).toFixed(1)} -> ${(s.afterMl / 1000).toFixed(1)} L (${(s.fallMl / 1000).toFixed(1)} L in ${((s.toT - s.fromT) / 60_000).toFixed(1)} min)`,
      `vib ${s.vibrationG?.toFixed(3) ?? '-'}`, d.vtype,
      s.refuel ? `refuel ${(s.refuel.fromMl / 1000).toFixed(1)} -> ${(s.refuel.toMl / 1000).toFixed(1)} L` : 'no refuel',
      `review ${d.review ?? (d.dismissed_at ? 'DISMISSED' : '-')}`,
    ].join(' | '))
  }
}

main().catch(e => { console.error('FAILED', e.message); process.exit(1) })
