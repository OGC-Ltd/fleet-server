/**
 * Archive (or restore) an organisation's geofences imported from Wialon.
 *
 *   npm run geofence:archive -- --org=MENENGAI                       dry run: what would be archived
 *   npm run geofence:archive -- --org=MENENGAI --tag=<tag> --apply   archive them, stamped with <tag>
 *   npm run geofence:archive -- --org=MENENGAI --tag=<tag> --undo    dry run of the restore
 *   npm run geofence:archive -- --org=MENENGAI --tag=<tag> --undo --apply
 *
 * "Imported from Wialon" = external_id LIKE 'wialon:zone:%'; fences drawn in the
 * app have no external_id and are never touched. Archived fences stay in the
 * table (history that names them by id still resolves) but are out of use
 * everywhere: see src/lib/fence-archive.ts. Rows are kept, so a later sync
 * finds them by key and leaves them alone instead of creating them again.
 *
 * --apply writes the archived ids to ~/archive-logs/<tag>.json. The running
 * server's zone cache refreshes within 5 minutes and the stop/idle watch within
 * an hour; restart the `server` pm2 process to apply it at once.
 */
import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const prisma  = new PrismaClient({ adapter: new PrismaPg(pool) })

const arg = (name: string): string | null => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3).trim() : null
}
const APPLY = process.argv.includes('--apply')
const UNDO  = process.argv.includes('--undo')
const ORG   = (arg('org') ?? '').toUpperCase()
const TAG   = arg('tag') ?? `wialon-archive-${new Date().toISOString().slice(0, 10)}`
const WIALON = 'wialon:zone:'

const HOME = /(yard|factory|mill|depot|(^| )hq( |$))/i

async function main() {
  if (!ORG) throw new Error('--org=<CODE> is required')
  if ((APPLY || UNDO) && !arg('tag')) throw new Error('--tag=<tag> is required with --apply and --undo')
  const org = await prisma.organisation.findUnique({ where: { code: ORG }, select: { id: true, code: true } })
  if (!org) throw new Error(`Organisation ${ORG} not found`)

  console.log(`\n🗄  Geofence archive — ${org.code} — ${UNDO ? 'RESTORE' : 'ARCHIVE'} — ${APPLY ? 'APPLY' : 'DRY RUN'} — tag ${TAG}\n`)
  return UNDO ? restore(org.id) : archive(org.id)
}

async function archive(orgId: string) {
  const where = { organisationId: orgId, externalId: { startsWith: WIALON }, archivedAt: null }
  const rows = await prisma.geofence.findMany({
    where, select: { id: true, name: true, type: true, isActive: true, mode: true, rule: true }, orderBy: { name: 'asc' },
  })
  const [already, appFences] = await Promise.all([
    prisma.geofence.count({ where: { organisationId: orgId, externalId: { startsWith: WIALON }, archivedAt: { not: null } } }),
    prisma.geofence.count({ where: { organisationId: orgId, externalId: null, archivedAt: null } }),
  ])

  const by = (f: (r: typeof rows[number]) => string) => Object.entries(rows.reduce<Record<string, number>>((m, r) => {
    m[f(r)] = (m[f(r)] ?? 0) + 1; return m
  }, {})).map(([k, n]) => `${k} ${n}`).join(', ')

  console.log(`  Wialon fences in use:      ${rows.length}`)
  console.log(`    by type:                 ${by(r => r.type) || 'none'}`)
  console.log(`    by state:                ${by(r => (r.isActive ? 'active' : 'inactive')) || 'none'}`)
  console.log(`  Already archived:          ${already}`)
  console.log(`  App fences (not touched):  ${appFences}`)

  const active = rows.filter(r => r.isActive)
  if (active.length) {
    console.log(`\n  Active ones (their ${active.filter(r => r.mode === 'BLOCKLIST').length} keep-out alerts stop):`)
    for (const r of active) console.log(`    · ${r.name} (${r.type}, ${r.mode}${r.rule ? ', has a rule' : ''})`)
  }
  const homes = rows.filter(r => HOME.test(r.name) && !/^menengai_vs/i.test(r.name))
  if (homes.length) {
    console.log('\n  Yard / depot / factory names (reports fall back to fixed points):')
    for (const r of homes) console.log(`    · ${r.name}`)
  }

  const ids = rows.map(r => r.id)
  const customers = ids.length ? await prisma.plannerCustomer.findMany({
    where: { organisationId: orgId, geofenceId: { in: ids } }, select: { id: true },
  }) : []
  const stops = customers.length ? await prisma.deliveryPlanStop.count({ where: { customerId: { in: customers.map(c => c.id) } } }) : 0
  console.log(`\n  Planner customers on these fences: ${customers.length} (${stops} plan stops) — they lose their fence until redrawn`)

  if (!APPLY) {
    console.log(`\n  · would archive ${ids.length}\n\n  DRY RUN — nothing was written. Re-run with --tag=<tag> --apply.\n`)
    return
  }
  if (!ids.length) { console.log('\n  Nothing to archive.\n'); return }

  const now = new Date()
  const done = await prisma.geofence.updateMany({
    where: { ...where, id: { in: ids } },
    data:  { archivedAt: now, archivedNote: TAG },
  })
  const file = writeLog({ tag: TAG, org: ORG, archivedAt: now.toISOString(), count: done.count, ids })
  console.log(`\n  ✓ archived ${done.count} (ids in ${file})`)
  console.log('  Restart pm2 `server` to apply at once; otherwise zone presence catches up within 5 min, stop/idle watch within an hour.\n')
}

async function restore(orgId: string) {
  const where = { organisationId: orgId, archivedNote: TAG, archivedAt: { not: null } }
  const n = await prisma.geofence.count({ where })
  console.log(`  Archived with tag ${TAG}: ${n}`)
  if (!APPLY) { console.log(`\n  · would restore ${n}\n\n  DRY RUN — nothing was written. Re-run with --apply.\n`); return }
  const done = await prisma.geofence.updateMany({ where, data: { archivedAt: null, archivedNote: null } })
  console.log(`\n  ✓ restored ${done.count}. Restart pm2 \`server\` to apply at once.\n`)
}

function writeLog(body: Record<string, unknown>): string {
  const dir = path.join(os.homedir(), 'archive-logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${String(body.tag).replace(/[^\w.-]/g, '_')}.json`)
  fs.writeFileSync(file, JSON.stringify(body, null, 2))
  return file
}

main()
  .catch(err => { console.error('\n❌  archive-geofences failed:', err); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
