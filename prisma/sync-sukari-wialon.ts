/**
 * Bind SUKARI's Wialon trackers to their existing vehicles — by registration plate.
 *
 * SUKARI's registry comes from Controltech/RaiFactorySuite: 598 vehicles with a
 * plate, name, type and driver, and **no coordinates at all** — that provider
 * exposes none. So every Sukari vehicle reports OFFLINE and the map is empty.
 *
 * Wialon now sees the Sukari fleet too (336 units under "SUKARI INDURSTRIES
 * LIMITED"), and its unit names carry the plate:
 *
 *   SUKARI-AMBULANCE-KBN 201N
 *   SUKARI-HARVESTING BUS-KBV 715U-2km/l
 *   SUKARI-PRIME MOVER-FAW-KBU 715P-2km/l
 *
 * Positions are keyed to `deviceId` all the way through the poller
 * (lib/poller getDeviceMeta), and the Wialon adapter already emits every unit
 * it can see as `wialon:<unitId>`. So binding is one column: point the matched
 * vehicle's `deviceId` at its Wialon unit and telemetry starts landing with no
 * code change.
 *
 * Why this is safe rather than a schema migration:
 *   • The Controltech alert/event webhooks resolve vehicles by
 *     `registrationPlate`, NOT deviceId (see raifactorysuite-*.service.ts) —
 *     so repointing deviceId does not sever the Controltech path.
 *   • `externalId` keeps the factorysuite UUID, so `sync:vehicles` still
 *     upserts the same rows.
 *   • `sync:vehicles` writes `deviceId` only on CREATE, never on update — this
 *     binding will not be clobbered by a later sync.
 *
 * Idempotent. Dry-run unless --apply.
 *
 * Run: npm run sync:sukari-gps            (preview)
 *      npm run sync:sukari-gps -- --apply (commit)
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { WialonClient } from '../src/providers/wialon/wialon.client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL  = process.env.WIALON_API_URL ?? 'https://hst-api.wialon.com'
const TOKEN    = process.env.WIALON_TOKEN || process.env.access_token || ''
const ORG_CODE = 'SUKARI'
const APPLY    = process.argv.includes('--apply')

/** Plates are written inconsistently across the two systems ("KBV 715U" vs
 *  "KBV715U"), so compare on letters and digits only. */
const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * Kenyan plates: 2-4 letters, 3-4 digits, optional trailing letter.
 * Anchored on the digits so fuel-economy suffixes ("2km/l") and asset names
 * ("BELL16", "TRAILER 60m") are not mistaken for registrations.
 */
const PLATE_RE = /\b([A-Z]{2,4}\s?\d{3,4}\s?[A-Z]?)\b/

/** Pull the plate and the descriptive type out of a Wialon unit name. */
function parseUnitName(nm: string): { plate: string | null; type: string | null } {
  const body  = nm.replace(/^SUKARI\s*-?\s*/i, '')
  const parts = body.split('-').map(p => p.trim()).filter(Boolean)

  let plate: string | null = null
  let at = -1
  for (let i = 0; i < parts.length; i++) {
    if (/km\/?l/i.test(parts[i]!)) continue          // "1.8km/l" is a fuel figure
    const m = parts[i]!.match(PLATE_RE)
    if (m && /\d/.test(m[1]!)) { plate = norm(m[1]); at = i; break }
  }
  // Everything before the plate describes the machine: "PRIME MOVER-FAW" etc.
  const type = at > 0 ? parts.slice(0, at).join(' ').trim() : null
  return { plate, type: type || null }
}

async function main() {
  if (!TOKEN) throw new Error('WIALON_TOKEN / access_token is not set')
  console.log(`\n🔗  Sukari GPS binding — Wialon units → vehicles by plate  ${APPLY ? '(APPLYING)' : '(dry run)'}\n`)

  const org = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  if (!org) throw new Error(`Organisation ${ORG_CODE} not found`)

  const client = new WialonClient(TOKEN, API_URL)
  await client.login()

  const units = await client.call<{ items?: Array<{ id: number; nm: string }> }>(
    'core/search_items',
    {
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: 'SUKARI*', sortType: 'sys_name' },
      force: 1, flags: 1, from: 0, to: 10_000,
    },
  )
  const items = units.items ?? []
  console.log(`  ← ${items.length} Wialon unit(s) named SUKARI*`)

  const parsed  = items.map(u => ({ id: u.id, nm: u.nm, ...parseUnitName(u.nm) }))
  const plated  = parsed.filter(p => p.plate)
  const noPlate = parsed.filter(p => !p.plate)
  console.log(`    ${plated.length} carry a readable plate, ${noPlate.length} do not`)

  const vehicles = await prisma.vehicle.findMany({
    where:  { organisationId: org.id },
    select: { id: true, registrationPlate: true, vehicleType: true, deviceId: true, name: true },
  })
  console.log(`  ← ${vehicles.length} ${ORG_CODE} vehicle(s) in the database`)

  const byPlate = new Map(vehicles.map(v => [norm(v.registrationPlate), v]))
  // deviceId is globally unique — know what is already taken before writing.
  const takenDeviceIds = new Set(
    (await prisma.vehicle.findMany({ select: { id: true, deviceId: true } }))
      .map(v => `${v.deviceId}`),
  )

  const toBind: Array<{ vehicleId: string; plate: string; deviceId: string; unit: string; wtype: string | null; dbtype: string }> = []
  const already: string[] = []
  const conflicts: string[] = []
  const unmatched: typeof plated = []

  for (const p of plated) {
    const v = byPlate.get(p.plate!)
    if (!v) { unmatched.push(p); continue }
    const deviceId = `wialon:${p.id}`
    if (v.deviceId === deviceId) { already.push(p.plate!); continue }
    // Another row already owns this deviceId (two Wialon units naming the same
    // plate, or a Kasulu unit) — skip rather than trip the unique constraint.
    if (takenDeviceIds.has(deviceId)) { conflicts.push(`${p.plate} → ${deviceId}`); continue }
    toBind.push({ vehicleId: v.id, plate: p.plate!, deviceId, unit: p.nm, wtype: p.type, dbtype: v.vehicleType })
  }

  console.log(`\n  matched and ready to bind: ${toBind.length}`)
  for (const b of toBind.slice(0, 15)) {
    console.log(`    ${b.plate.padEnd(10)} → ${b.deviceId.padEnd(16)} ${String(b.wtype ?? '—').padEnd(18)} (db: ${b.dbtype})`)
  }
  if (toBind.length > 15) console.log(`    … and ${toBind.length - 15} more`)

  if (already.length)   console.log(`\n  already bound: ${already.length}`)
  if (conflicts.length) {
    console.log(`\n  ⚠  deviceId already taken, skipped (${conflicts.length}):`)
    for (const c of conflicts.slice(0, 8)) console.log(`    ${c}`)
  }
  console.log(`\n  no matching vehicle in the DB (${unmatched.length}) — these units have no registry row:`)
  for (const m of unmatched.slice(0, 10)) console.log(`    ${m.plate!.padEnd(10)} ${m.nm}`)
  if (unmatched.length > 10) console.log(`    … and ${unmatched.length - 10} more`)

  const bindable = toBind.length + already.length
  console.log(`\n  ── coverage ─────────────────────────────────────────────`)
  console.log(`  ${bindable} of ${vehicles.length} ${ORG_CODE} vehicles will have a live tracker`)
  console.log(`  ${vehicles.length - bindable} have no Wialon unit and will stay OFFLINE (no hardware to report)`)

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with:  npm run sync:sukari-gps -- --apply\n')
    await client.logout()
    return
  }

  let bound = 0
  for (const b of toBind) {
    try {
      await prisma.vehicle.update({ where: { id: b.vehicleId }, data: { deviceId: b.deviceId } })
      bound++
    } catch (err) {
      console.error(`  ✗ ${b.plate}: ${err instanceof Error ? err.message.split('\n').at(-1) : err}`)
    }
  }
  console.log(`\n  ✓ bound ${bound} vehicle(s) to their Wialon unit`)
  console.log('    Positions arrive on the next poll cycle — the adapter already')
  console.log('    emits every visible unit as wialon:<id>; these rows can now receive them.\n')

  await client.logout()
}

main()
  .catch(err => { console.error('\n❌  sync-sukari-wialon failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
