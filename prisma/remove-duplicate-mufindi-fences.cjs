/**
 * Removes the three old Mufindi fences that the zones on its current Wialon
 * resource replaced (2026-11-04). Dry run unless --apply is passed.
 *
 * Refuses unless every row still has the expected name, is inactive, has no
 * vehicle bindings or violations, and its replacement exists. --apply writes the
 * rows to a backup file before deleting them, all in one transaction.
 *
 * Run from the fleet-server directory on the box.
 */
const { createRequire } = require('module')
const { writeFileSync } = require('fs')
const { homedir } = require('os')
const { join } = require('path')

const req = createRequire(join(process.cwd(), 'noop.js'))
req('dotenv').config({ quiet: true })
const { Client } = req('pg')

const APPLY = process.argv.includes('--apply')
const PAIRS = [
  { old: 'wialon:zone:10', oldName: 'Factory site Location', keep: 'wialon:zone:30394506:4' },
  { old: 'wialon:zone:16', oldName: 'Logistic centre1', keep: 'wialon:zone:30394506:2' },
  { old: 'wialon:zone:17', oldName: 'Logistic centre2', keep: 'wialon:zone:30394506:3' },
]

async function main() {
  const url = process.env.DIRECT_URL
  const db = new Client({ connectionString: url, ssl: url.includes('sslmode') ? undefined : { rejectUnauthorized: false } })
  await db.connect()
  try {
    await db.query('BEGIN')
    const rows = []
    for (const p of PAIRS) {
      const { rows: [row] } = await db.query(`
        SELECT g.*, ST_AsGeoJSON(g.geom) AS geom_json, o.code AS org_code,
          (SELECT count(*)::int FROM vehicle_geofences v WHERE v.geofence_id = g.id) AS bindings,
          (SELECT count(*)::int FROM geofence_violations x WHERE x.geofence_id = g.id) AS violations
        FROM geofences g JOIN organisations o ON o.id = g.organisation_id
        WHERE g.external_id = $1 FOR UPDATE OF g`, [p.old])
      const { rows: [keep] } = await db.query(`
        SELECT g.name, o.code AS org_code FROM geofences g JOIN organisations o ON o.id = g.organisation_id
        WHERE g.external_id = $1`, [p.keep])
      if (!row) throw new Error(`${p.old} (${p.oldName}) is already gone`)
      if (row.org_code !== 'KASULU' || row.name !== p.oldName) throw new Error(`${p.old} is now "${row.name}" in ${row.org_code}`)
      if (row.is_active || row.bindings || row.violations) {
        throw new Error(`${p.oldName} is in use: active=${row.is_active}, bindings=${row.bindings}, violations=${row.violations}`)
      }
      if (keep?.org_code !== 'KASULU') throw new Error(`Replacement ${p.keep} is missing`)
      rows.push(row)
      console.log(`${APPLY ? 'Removing' : 'Would remove'} "${row.name}" (${p.old}); keeping "${keep.name}" (${p.keep})`)
    }
    if (!APPLY) {
      await db.query('ROLLBACK')
      console.log('\nDRY RUN: nothing changed. Pass --apply to remove them.')
      return
    }
    const backup = join(homedir(), 'removed-mufindi-fences-2026-11-04.json')
    writeFileSync(backup, JSON.stringify(rows, null, 2), { flag: 'wx' })
    const { rowCount } = await db.query('DELETE FROM geofences WHERE id = ANY($1)', [rows.map(r => r.id)])
    if (rowCount !== PAIRS.length) throw new Error(`Deleted ${rowCount}, expected ${PAIRS.length}`)
    await db.query('COMMIT')
    console.log(`\nRemoved ${rowCount}. Backup: ${backup}`)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await db.end()
  }
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1) })
