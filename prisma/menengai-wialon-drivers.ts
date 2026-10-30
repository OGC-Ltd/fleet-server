/**
 * READ-ONLY. Menengai's Wialon driver bindings against our assignments.
 *
 * Wialon's Mene-ngai resource holds drivers bound to units (iButton / tag /
 * dispatcher binding). For every bound driver: which of our vehicles the unit
 * is, which of our Menengai users the name is, and what our current mapping
 * says — so the gaps it could fill are counted before anything is written.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import pg from 'pg'
import { WialonClient } from '../src/providers/wialon/wialon.client.js'
import { MENENGAI_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean)

async function main() {
  const env = dotenv.parse(fs.readFileSync(path.join(os.homedir(), 'prod/fleet-server/.env')))
  const c = new pg.Client({ connectionString: env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  if ((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('not read-only')

  const vehicles = (await c.query(`
    SELECT v.id, v.device_id, v.registration_plate plate,
      (SELECT u.full_name FROM vehicle_assignments va JOIN users u ON u.id=va.user_id
        WHERE va.vehicle_id=v.id AND va.unassigned_at IS NULL AND (va.notes IS NULL OR va.notes NOT LIKE 'controltech:%')
        ORDER BY va.assigned_at DESC LIMIT 1) ours,
      EXISTS (SELECT 1 FROM vehicle_telemetries t WHERE t.vehicle_id=v.id AND t.captured_at >= now() - interval '2 day') reporting
      FROM vehicles v JOIN organisations o ON o.id=v.organisation_id WHERE o.code='MENENGAI'`)).rows
  const users = (await c.query(`SELECT u.id, u.full_name FROM users u JOIN organisations o ON o.id=u.organisation_id WHERE o.code='MENENGAI' AND u.deleted_at IS NULL`)).rows
  await c.end()

  const client = new WialonClient(env.WIALON_TOKEN || env.access_token || '', env.WIALON_API_URL || undefined)
  const res = await client.call<{ item?: { drvrs?: Record<string, { n?: string; bu?: number; c?: string }> } }>(
    'core/search_item', { id: MENENGAI_WIALON_ACCOUNT_ID, flags: 0x00000001 | 0x00000100 })
  const drivers = Object.values(res.item?.drvrs ?? {})

  const byDevice = new Map(vehicles.map(v => [v.device_id, v]))
  // A name matches a user when every word of the shorter name is in the longer one.
  const userFor = (name: string) => {
    const w = norm(name)
    const hits = users.filter(u => { const x = norm(u.full_name); const [a, b] = w.length <= x.length ? [w, x] : [x, w]; return a.length >= 2 && a.every(t => b.includes(t)) })
    return hits.length === 1 ? hits[0] : hits.length > 1 ? 'AMBIGUOUS' : null
  }

  const tally = { bound: 0, noVehicle: 0, noUser: 0, ambiguous: 0, agrees: 0, fillsGap: 0, fillsGapReporting: 0, disagrees: 0 }
  const disagree: string[] = [], gaps: string[] = [], unmatched: string[] = []
  for (const d of drivers) {
    if (!d.bu || d.bu <= 0) continue
    tally.bound++
    const v = byDevice.get(`wialon:${d.bu}`)
    if (!v) { tally.noVehicle++; continue }
    const u = userFor(d.n ?? '')
    if (u === 'AMBIGUOUS') { tally.ambiguous++; continue }
    if (!u) { tally.noUser++; unmatched.push(`${v.plate}: ${d.n}`); continue }
    if (!v.ours) { tally.fillsGap++; if (v.reporting) tally.fillsGapReporting++; gaps.push(`${v.plate}${v.reporting ? '' : ' (not reporting)'}: ${u.full_name}`) }
    else if (norm(v.ours).join(' ') === norm(u.full_name).join(' ')) tally.agrees++
    else { tally.disagrees++; disagree.push(`${v.plate}: ours ${v.ours} / Wialon ${u.full_name}`) }
  }
  const unmappedReporting = vehicles.filter(v => v.reporting && !v.ours).length
  console.log(JSON.stringify({ wialonDrivers: drivers.length, ...tally, menengaiReportingWithoutDriver: unmappedReporting }, null, 1))
  console.log('\nWOULD FILL:\n ' + gaps.join('\n '))
  console.log('\nDISAGREE:\n ' + disagree.join('\n '))
  console.log('\nWIALON NAME NOT A MENENGAI USER:\n ' + unmatched.slice(0, 25).join('\n '))
}
main().catch(e => { console.error(e); process.exit(1) })
