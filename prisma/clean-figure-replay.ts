/**
 * READ-ONLY replay of the clean drain figure (judgeDrain's lossMl, 2026-10-29):
 * for every DRAIN in the window, re-measure the fall between settled levels and
 * take off what the engine burnt, then set it beside the figure on the ledger
 * (`measured_drop_ml`) and the provider's (`stolen_ml`). Writes nothing.
 *
 *   node prisma/signal-alerts.build.mjs prisma/clean-figure-replay.ts clean-replay.cjs
 *   NODE_PATH=~/prod/fleet-server/node_modules node clean-replay.cjs [days] [plate]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import pg from 'pg'
import { smoothLevels } from '../src/modules/fuel/fuel-adjudication.js'
import { measureFall, type FallSample } from '../src/modules/fuel/fuel-drop-shape.js'
import { resolveBand, resolveBasis, classifyDrain, announces, burnDuringFallMl, type ProbeProfile } from '../src/modules/fuel/fuel-theft-classifier.js'
import { SWING_ML } from '../src/modules/fuel/fuel-adjudication.js'
import { STANDING_THEFT_REASONS } from '../src/modules/fuel/standing-theft.js'
import { assembleBandInputs } from '../src/modules/fuel/fuel-rate.js'

const LOOKBEHIND_MS = 30 * 60_000
const LOOKAHEAD_MS = 3 * 60 * 60_000
const days = Number(process.argv[2] ?? 7)
const plateLike = process.argv[3] ?? null

pg.types.setTypeParser(1114, s => new Date(s.replace(' ', 'T') + 'Z'))
const ts = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')
const EAT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const L = (ml: number | null) => ml == null ? '-' : (ml / 1000).toFixed(1)
const pct = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : NaN }

async function main() {
  const env = dotenv.parse(fs.readFileSync(path.join(os.homedir(), 'prod/fleet-server/.env')))
  const c = new pg.Client({ connectionString: env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  if ((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('not read-only')
  await c.query("SET statement_timeout = '90s'")

  const vehicles = (await c.query(`
    SELECT v.id, v.registration_plate AS "registrationPlate", v.vehicle_type::text AS "vehicleType",
           v.organisation_id AS "organisationId", v.tank_capacity_litres AS "tankCapacityLitres", o.code
      FROM vehicles v LEFT JOIN organisations o ON o.id = v.organisation_id`)).rows
  const rates = (await c.query(`SELECT vehicle_id AS "vehicleId", l_per_hour AS "lPerHour", l_per_km AS "lPerKm", runs FROM vehicle_fuel_rates`)).rows
  const inputs = assembleBandInputs(vehicles.map(v => ({ ...v, organisation: v.code ? { code: v.code } : null })), rates)

  const from = new Date(Date.now() - days * 86_400_000)
  const drains = (await c.query(`
    SELECT t.id, t.vehicle_id, v.registration_plate AS plate, t.began_at, t.detected_at,
           t.stolen_ml, t.measured_drop_ml, t.drain_cause::text AS cause, t.cause_reason AS reason
      FROM fuel_thefts t JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.began_at >= $1::timestamp AND t.verdict::text = 'DRAIN' AND t.measured_drop_ml IS NOT NULL
       AND ($2::text IS NULL OR v.registration_plate ILIKE $2)
     ORDER BY t.began_at`, [ts(from), plateLike])).rows

  // The probe profile as getProbeProfile reads it (21 days, 30-min parked
  // windows), taken as of now rather than of each drain's judgement.
  // A vehicle whose profile read times out is judged without one (as a new
  // machine would be) rather than ending the run; counted in `noProfile`.
  const profiles = new Map<string, ProbeProfile | null>()
  let noProfile = 0
  const profileOf = async (vehicleId: string): Promise<ProbeProfile | null> => {
    if (profiles.has(vehicleId)) return profiles.get(vehicleId)!
    let r
    try { r = (await c.query(`
      WITH win AS (
        SELECT date_trunc('hour', captured_at) + interval '30 min' * floor(extract(minute FROM captured_at) / 30) AS bucket,
               count(*) AS n, max(fuel_level_ml) - min(fuel_level_ml) AS swing,
               max(coalesce(speed_kmh, 0)) AS top_speed, count(*) FILTER (WHERE engine_on) AS running
          FROM vehicle_telemetries
         WHERE vehicle_id = $1 AND captured_at >= $2::timestamp AND fuel_level_ml IS NOT NULL
         GROUP BY 1)
      , cap AS (
        SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY t.fuel_level_ml) / 1000.0 / NULLIF(v.tank_capacity_litres, 0) AS fill_ratio
          FROM vehicle_telemetries t JOIN vehicles v ON v.id = t.vehicle_id
         WHERE t.vehicle_id = $1 AND t.captured_at >= $2::timestamp AND t.fuel_level_ml IS NOT NULL
         GROUP BY v.tank_capacity_litres)
      SELECT count(*) AS parked, count(*) FILTER (WHERE swing >= $3) AS swinging, (SELECT fill_ratio FROM cap) AS fill_ratio
        FROM win WHERE n >= 30 AND top_speed = 0 AND running = 0`,
      [vehicleId, ts(new Date(Date.now() - 21 * 86_400_000)), SWING_ML])).rows[0] }
    catch (e) {
      if ((e as { code?: string }).code !== '57014') throw e
      noProfile++; profiles.set(vehicleId, null); return null
    }
    const p: ProbeProfile = { parkedWindows: Number(r?.parked ?? 0), swingWindows: Number(r?.swinging ?? 0), fillRatio: r?.fill_ratio != null ? Number(r.fill_ratio) : null }
    profiles.set(vehicleId, p); return p
  }

  const lost: typeof drains = []
  const out: Array<{ d: typeof drains[number]; dropMl: number; burnMl: number; lossMl: number; cause: string; reason: string; announced: boolean }> = []
  for (const d of drains) {
    const rows = (await c.query(`
      SELECT t.captured_at, t.fuel_level_ml, t.engine_on, t.speed_kmh, (r.payload->>'ignition_known')::boolean AS ignition_known
        FROM vehicle_telemetries t JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
       WHERE t.vehicle_id = $1 AND t.captured_at >= $2::timestamp AND t.captured_at <= $3::timestamp
         AND t.fuel_level_ml IS NOT NULL
       ORDER BY t.captured_at ASC`,
      [d.vehicle_id, ts(new Date(d.began_at.getTime() - LOOKBEHIND_MS)), ts(new Date(d.detected_at.getTime() + LOOKAHEAD_MS))])).rows
    const fall: FallSample[] = rows.map(r => ({
      capturedAt: r.captured_at, fuelLevelMl: r.fuel_level_ml,
      engineOn: r.ignition_known === true ? r.engine_on : undefined, speedKmh: r.speed_kmh,
    }))
    const m = measureFall(fall, { beganAt: d.began_at, detectedAt: d.detected_at }, smoothLevels)
    if (m == null) { lost.push(d); continue }
    const b = inputs.get(d.vehicle_id)
    const band = b ? resolveBand(b.orgCode, { plate: b.plate, vehicleType: b.vehicleType, tankCapacityLitres: b.tankCapacityLitres },
      b.rate == null ? null : { lPerHour: b.rate.lPerHour, basis: b.rate.basis, lPerKm: b.lPerKm }) : null
    const burnMl = burnDuringFallMl(m.clean.fall, band)
    const basis = b ? resolveBasis(b.orgCode, { plate: b.plate, vehicleType: b.vehicleType, tankCapacityLitres: b.tankCapacityLitres }) : undefined
    const j = classifyDrain(m.evidence, band, await profileOf(d.vehicle_id), basis)
    out.push({ d, dropMl: m.clean.dropMl, burnMl, lossMl: Math.max(0, m.clean.dropMl - burnMl), cause: j.cause, reason: j.reason, announced: announces(j) })
  }

  const n = out.length
  const slosh = out.map(o => o.d.measured_drop_ml - o.dropMl)
  console.log(`${days} days${plateLike ? ` (${plateLike})` : ''}: ${drains.length} drains with a stored figure, ${n} re-measured`)
  console.log(`stored total ${L(out.reduce((a, o) => a + o.d.measured_drop_ml, 0))} L -> slosh-free ${L(out.reduce((a, o) => a + o.dropMl, 0))} L -> clean ${L(out.reduce((a, o) => a + o.lossMl, 0))} L; provider ${L(out.reduce((a, o) => a + o.d.stolen_ml, 0))} L`)
  console.log(`slosh removed per drain: changed on ${slosh.filter(x => Math.abs(x) >= 500).length}; p50 ${L(pct(slosh, 0.5))} p90 ${L(pct(slosh, 0.9))} max ${L(Math.max(...slosh.slice(0, 50_000)))} L`)
  const burns = out.map(o => o.burnMl)
  console.log(`burn taken off: on ${burns.filter(x => x > 0).length}; p50 ${L(pct(burns, 0.5))} p90 ${L(pct(burns, 0.9))} L; clean = 0 on ${out.filter(o => o.lossMl === 0).length}`)
  const byCause = new Map<string, { n: number; stored: number; clean: number }>()
  for (const o of out) {
    const k = o.d.cause ?? '-'; const e = byCause.get(k) ?? { n: 0, stored: 0, clean: 0 }
    e.n++; e.stored += o.d.measured_drop_ml; e.clean += o.lossMl; byCause.set(k, e)
  }
  console.log('by cause (n, stored L, clean L):', JSON.stringify([...byCause].map(([k, e]) => [k, e.n, Math.round(e.stored / 1000), Math.round(e.clean / 1000)])))
  // Re-judged on the new geometry against the cause on the ledger. Standing
  // calls are left out: this replay does not run the standing rule.
  const judged = out.filter(o => !(STANDING_THEFT_REASONS as readonly string[]).includes(o.d.reason))
  const flips = new Map<string, number>()
  for (const o of judged) {
    const k = `${o.d.cause} -> ${o.cause}`
    if (o.cause !== o.d.cause) flips.set(k, (flips.get(k) ?? 0) + 1)
  }
  console.log(`vehicles judged without a probe profile (read timed out): ${noProfile}`)
  console.log(`re-judged ${judged.length} (standing calls left out): cause unchanged on ${judged.filter(o => o.cause === o.d.cause).length}`)
  console.log('cause flips (ledger -> now):', JSON.stringify([...flips].sort((x, y) => y[1] - x[1])))
  console.log(`announced now but clean 0, alert withheld: ${out.filter(o => o.announced && o.lossMl === 0 && o.cause !== 'SIPHON').length}`)
  const shown = [...out].sort((a, b) => (b.d.measured_drop_ml - b.lossMl) - (a.d.measured_drop_ml - a.lossMl)).slice(0, plateLike ? 50 : 25)
  for (const o of shown) {
    console.log(`${EAT.format(o.d.began_at)} | ${o.d.plate} | ${o.d.cause}/${o.d.reason} -> ${o.cause}/${o.reason} | provider ${L(o.d.stolen_ml)} | stored ${L(o.d.measured_drop_ml)} | slosh-free ${L(o.dropMl)} | burn ${L(o.burnMl)} | clean ${L(o.lossMl)}`)
  }
  const lostBy = new Map<string, number>()
  for (const d of lost) lostBy.set(`${d.cause}/${d.reason}`, (lostBy.get(`${d.cause}/${d.reason}`) ?? 0) + 1)
  console.log('no longer measurable, by stored cause:', JSON.stringify([...lostBy].sort((x, y) => y[1] - x[1])))
  for (const d of lost.filter(d => d.cause === 'SIPHON' || d.cause === 'UNEXPLAINED_BURN').slice(0, 15)) {
    console.log(`  ${EAT.format(d.began_at)} | ${d.plate} | ${d.cause}/${d.reason} | provider ${L(d.stolen_ml)} | stored ${L(d.measured_drop_ml)} | ${Math.round((d.detected_at - d.began_at) / 60000)} min`)
  }
  await c.end()
}

main().catch(e => { console.error(e); process.exit(1) })
