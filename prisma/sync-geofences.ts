/**
 * Geofence sync — Wialon geozones → `geofences` (KASULU).
 *
 * The customer already maintains their operational zones in Wialon (factory
 * site, logistics centres, farms, haulage roads, drains, rivers, VES points).
 * Those definitions are the source of truth — this imports them rather than
 * inventing a parallel set that would immediately drift.
 *
 * Wialon zone types map as:
 *   3 CIRCLE  → CIRCLE   (one point carrying its radius in metres)
 *   2 POLYGON → POLYGON  (vertex ring)
 *   1 LINE    → LINE     (centre-line + width — a corridor; see lib/geofence)
 *
 * Idempotent on `external_id = "wialon:zone:<id>"`, so re-running updates in
 * place and picks up edits made in Wialon.
 *
 * IMPORTANT — this imports DEFINITIONS ONLY. It deliberately does not bind any
 * vehicle to any fence: which zones are enforced, and whether each is a
 * keep-in (ALLOWLIST) or keep-out (BLOCKLIST) rule, is an operational policy
 * decision. Binding 107 zones to 224 vehicles blindly would generate tens of
 * thousands of violations on the first poll cycle. Assign deliberately with
 * `npm run geofence:assign` once the policy is agreed.
 *
 * Run: npm run sync:geofences
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { WialonClient } from '../src/providers/wialon/wialon.client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.WIALON_API_URL ?? 'https://hst-api.wialon.com'
const TOKEN   = process.env.WIALON_TOKEN || process.env.access_token || ''
const ORG_CODE = 'KASULU'

/** Wialon zone type → ours. */
const ZONE_TYPE = { 1: 'LINE', 2: 'POLYGON', 3: 'CIRCLE' } as const

interface WialonZonePoint { x: number; y: number; r?: number }
interface WialonZone {
  id: number
  n:  string                 // name
  d?: string                 // description
  t:  number                 // 1 line | 2 polygon | 3 circle
  w?: number                 // width (line) — also radius fallback for circles
  p?: WialonZonePoint[]      // vertices; circles carry a single point with r
}

async function main() {
  if (!TOKEN) throw new Error('WIALON_TOKEN (or access_token) is not set')
  console.log(`\n🔄  Geofence sync — Wialon → org ${ORG_CODE}\n`)

  const org = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  if (!org) throw new Error(`Organisation ${ORG_CODE} not found`)

  const client = new WialonClient(TOKEN, API_URL)
  await client.login()

  // Zones hang off the RESOURCE, not the units.
  const res = await client.call<{ items?: Array<{ id: number; nm: string; zl?: Record<string, unknown> }> }>(
    'core/search_items',
    {
      spec: { itemsType: 'avl_resource', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
      force: 1, flags: 1 | 0x1000 | 0x2000 | 0x4000, from: 0, to: 100,
    },
  )
  const resource = (res.items ?? [])[0]
  if (!resource) throw new Error('No Wialon resource visible to this account')

  const zoneIds = Object.values(resource.zl ?? {}).map((z) => (z as { id: number }).id)
  if (zoneIds.length === 0) {
    console.log('  ← the resource holds no geozones — nothing to import.\n')
    return
  }

  // flags 0xFF is the combination that returns vertex data (`p`); narrower
  // flags return only metadata (area/perimeter/bounds).
  const zones = await client.call<WialonZone[]>('resource/get_zone_data', {
    itemId: resource.id, col: zoneIds, flags: 0xFF,
  })
  console.log(`  ← ${zones.length} geozones from "${resource.nm}"`)

  let created = 0, updated = 0, skipped = 0
  const byType: Record<string, number> = {}
  const seen: string[] = []

  for (const z of zones) {
    const kind = ZONE_TYPE[z.t as 1 | 2 | 3]
    const pts = z.p ?? []
    if (!kind || pts.length === 0) { skipped++; continue }

    const externalId = `wialon:zone:${z.id}`
    seen.push(externalId)

    // Shared shape; geometry columns filled per type below.
    const base = {
      organisationId: org.id,
      name:           (z.n ?? `Zone ${z.id}`).trim(),
      // Everything imports as a keep-out rule and INACTIVE — see the header:
      // enforcement is a deliberate decision, not a side effect of syncing.
      mode:           'BLOCKLIST' as const,
      isActive:       false,
      centerLat:      null as number | null,
      centerLng:      null as number | null,
      radiusM:        null as number | null,
      polygonCoords:  null as unknown,
      widthM:         null as number | null,
    }

    let data: typeof base & { type: 'CIRCLE' | 'POLYGON' | 'LINE' }

    if (kind === 'CIRCLE') {
      const c = pts[0]!
      data = {
        ...base, type: 'CIRCLE',
        centerLat: c.y, centerLng: c.x,
        // The point's own radius wins; `w` is the fallback.
        radiusM: Math.round(c.r ?? z.w ?? 0),
      }
      if (!data.radiusM || data.radiusM <= 0) { skipped++; continue }
    } else {
      // Both polygons and corridors store [[lng, lat], …] — the ordering the
      // geometry helpers and GeoJSON both expect.
      const coords = pts.map(p => [p.x, p.y] as [number, number])
      data = kind === 'POLYGON'
        ? { ...base, type: 'POLYGON', polygonCoords: coords }
        : { ...base, type: 'LINE', polygonCoords: coords, widthM: z.w ?? 1 }
    }

    const existing = await prisma.geofence.findUnique({ where: { externalId }, select: { id: true, isActive: true, mode: true } })
    if (existing) {
      // Never clobber an enforcement decision already made in our system —
      // re-syncing refreshes geometry and name, not policy.
      const { mode: _m, isActive: _a, ...geometry } = data
      await prisma.geofence.update({ where: { externalId }, data: geometry })
      updated++
    } else {
      await prisma.geofence.create({ data: { ...data, externalId } })
      created++
    }
    byType[kind] = (byType[kind] ?? 0) + 1
  }

  console.log(`\n  ✓ created ${created}, updated ${updated}, skipped ${skipped} (unsupported or empty geometry)`)
  console.log(`  ✓ by type: ${Object.entries(byType).map(([k, n]) => `${k} ${n}`).join(', ')}`)

  const active = await prisma.geofence.count({ where: { organisationId: org.id, isActive: true } })
  const bound  = await prisma.vehicleGeofence.count()
  console.log(`\n  ℹ  ${active} fence(s) currently ENFORCED, ${bound} vehicle bindings.`)
  console.log('     Definitions import inactive by design — enforce with npm run geofence:assign.\n')

  await client.logout()
}

main()
  .catch(err => { console.error('\n❌  sync-geofences failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
