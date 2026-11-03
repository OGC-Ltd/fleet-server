/**
 * Moves five fences the Wialon import filed under the wrong organisation
 * (operator, 2026-11-04). The reseller keeps zones on whichever resource it
 * likes, so the import put them where they were found, not whose they are.
 *
 * Each row is moved in place, so its id, external id and any history stay
 * attached. sync-geofences.ts now leaves these names out of the old owner's
 * sync; without that it would stop with "belongs to another organisation".
 *
 * DRY RUN BY DEFAULT, like the sync.
 *
 * Run: npx tsx prisma/move-misfiled-geofences.ts
 *      npx tsx prisma/move-misfiled-geofences.ts --apply
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const prisma  = new PrismaClient({ adapter: new PrismaPg(pool) })
const APPLY   = process.argv.includes('--apply')

const MOVES = [
  { id: 'cmuyej33g0002keqfk9wyk1nm', name: 'Menengai yard',                  from: 'AQUAMIST', to: 'MENENGAI' },
  { id: 'cmw12m6d604qw9sqfbte1wxgq', name: 'Aquamist Factory_Sigona',        from: 'MENENGAI', to: 'AQUAMIST' },
  { id: 'cmw12m6d104qv9sqfvxngxg9o', name: 'Aquamist Factory_Sigona (Main)', from: 'MENENGAI', to: 'AQUAMIST' },
  { id: 'cmw12lf4u00039sqfgcjdweap', name: 'RAIPLY Eldoret',                 from: 'MENENGAI', to: 'WESTSUGAR' },
  { id: 'cmw12m3qg049p9sqfnhlfjz20', name: 'Kabras stop over',               from: 'MENENGAI', to: 'KABRAS' },
] as const

async function main() {
  console.log(APPLY ? 'APPLY: writing\n' : 'DRY RUN: nothing will be written (pass --apply)\n')

  const orgs = await prisma.organisation.findMany({
    where:  { code: { in: [...new Set(MOVES.flatMap(m => [m.from, m.to]))] } },
    select: { id: true, code: true },
  })
  const orgId = new Map(orgs.map(o => [o.code, o.id]))
  const updates: Array<{ id: string; organisationId: string }> = []

  // Every row is checked before any is written, so a surprise moves nothing.
  for (const m of MOVES) {
    const to   = orgId.get(m.to)
    const from = orgId.get(m.from)
    if (!to || !from) throw new Error(`Organisation missing for ${m.name}: ${m.from} → ${m.to}`)

    const row = await prisma.geofence.findUnique({
      where:  { id: m.id },
      select: { name: true, organisationId: true, externalId: true, isActive: true },
    })
    if (!row) throw new Error(`${m.name}: row ${m.id} not found`)
    if (row.name.trim() !== m.name) throw new Error(`${m.id}: expected "${m.name}", found "${row.name}"`)
    if (row.organisationId !== from) throw new Error(`${m.name}: no longer under ${m.from}`)

    const bindings   = await prisma.vehicleGeofence.count({ where: { geofenceId: m.id } })
    const violations = await prisma.geofenceViolation.count({ where: { geofenceId: m.id } })
    // A binding ties the fence to a vehicle of the old organisation.
    if (bindings) throw new Error(`${m.name}: bound to ${bindings} vehicle(s), refusing to move`)

    console.log(`${m.name}: ${m.from} → ${m.to} | ${row.externalId} | active ${row.isActive} | violations ${violations}`)
    updates.push({ id: m.id, organisationId: to })
  }

  if (APPLY) {
    await prisma.$transaction(updates.map(u =>
      prisma.geofence.update({ where: { id: u.id }, data: { organisationId: u.organisationId } })))
    console.log(`\nMoved ${updates.length} fences.`)
  } else {
    console.log(`\nDRY RUN: would move ${updates.length} fences.`)
  }

  for (const o of orgs) {
    console.log(`${o.code}: ${await prisma.geofence.count({ where: { organisationId: o.id } })} fences`)
  }
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
