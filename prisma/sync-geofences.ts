/**
 * Geofence sync — Wialon geozones → `geofences`.
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
 * …with one correction. Wialon's drawing tools let an operator trace an AREA
 * boundary with the polyline tool, and the estate's own zones were captured
 * that way: "2500 Ha Area", "Commercial Area", the FARM#210-215 blocks, the
 * nurseries and the rainfed area all arrive as type 1 carrying a 1-3 m width.
 * Taking that at face value models a 2,354-hectare field as a one-metre-wide
 * corridor — it draws as a hairline on the map, and containment tests the
 * wrong thing entirely. Those rings close exactly on themselves, which is what
 * separates them from the real corridors (drains, rivers, haulage roads, whose
 * endpoints sit 1-29 km apart), so closure is the discriminator — see
 * isClosedRing below.
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
 * ## One token, four customers — the org is chosen, never assumed
 *
 * This used to be hardcoded to KASULU, which is why Mufindi has 107 fences and
 * Sukari, Menengai and West Sugar have none at all. The zones hang off a Wialon
 * RESOURCE, and the reseller put five customers on one credential, so the org
 * and its resource are named explicitly — see ZONE_SOURCE. Getting this wrong
 * writes another estate's boundaries into a fleet that has never seen them,
 * which is the accident wialon.account.ts was written to prevent.
 *
 * A NAME MASK is needed as well as a resource wherever the resource is shared
 * or enormous. Mene-ngai's holds 6,169 zones AND Sukari's factory boundary, so
 * both orgs that read it must filter: importing it whole would put every one of
 * those zones into the in-memory list zone-presence walks per telemetry ping,
 * and into the browser's containment test per stranded candidate.
 *
 * ## Areas by default, corridors on request
 *
 * `--shapes=area` (the default) imports polygons and circles only. A corridor
 * is a road — "Sukari to Rapogii road (Tarmac)" — and a unit standing on one is
 * stopped ON THE WAY somewhere, which is exactly what the stranded-stop flag
 * exists to surface. Pass `--shapes=all` to bring corridors in as reference
 * geometry; nothing treats them as containment either way.
 *
 * ## DRY RUN BY DEFAULT
 *
 * Like `geofence:assign` and `fix:rings` beside it. This writes to the shared
 * production database, and the previous version did so the moment it was run
 * with no argument at all.
 *
 * ## Finding a zone when it is not where you expect
 *
 * `--find=<text>` searches EVERY resource the token can see and prints which
 * one holds each match. Read-only, no database needed. This exists because the
 * reseller files zones and units independently — "SUKARI INDUSTRIES FACTORY"
 * lives on Mene-ngai's resource, not beside Sukari's units on Rai Group's — and
 * a wrong guess writes one customer's boundaries into another's estate.
 * `--resource=<id>` then imports from whichever resource it names.
 *
 * Run: npm run sync:geofences -- --find="sukari"
 *      npm run sync:geofences -- --org=SUKARI --name="sukari"
 *      npm run sync:geofences -- --org=SUKARI --name="sukari" --apply
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { WialonClient } from '../src/providers/wialon/wialon.client.js'
import {
  KASULU_WIALON_ACCOUNT_ID,
  MENENGAI_WIALON_ACCOUNT_ID,
  WEST_SUGAR_REPORT_RESOURCE_ID,
} from '../src/providers/wialon/wialon.account.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.WIALON_API_URL ?? 'https://hst-api.wialon.com'
const TOKEN   = process.env.WIALON_TOKEN || process.env.access_token || ''
/**
 * Which Wialon resource holds which org's zones.
 *
 * Deliberately its own map rather than a reuse of wialon.account's FLEETS:
 * that registry answers "whose UNITS are these", and its nameMask exists to
 * split units. SUKARI is absent from it on purpose — its vehicle registry comes
 * from RaiFactorySuite — but its ZONES are in Wialon like everyone else's.
 */
const ZONE_SOURCE: Record<string, { accountId: number; label: string }> = {
  KASULU:    { accountId: KASULU_WIALON_ACCOUNT_ID,      label: 'Mufindi Paper Mills' },
  MENENGAI:  { accountId: MENENGAI_WIALON_ACCOUNT_ID,    label: 'Mene-ngai' },
  /**
   * NOT Rai Group, where Sukari's UNITS live.
   *
   * "SUKARI INDUSTRIES FACTORY" (84.484 ha, 3.802 km perimeter) sits on the
   * Mene-ngai resource — confirmed in the Wialon UI on 2026-09-07, after this
   * map was first written pointing at Rai Group on the reasonable-looking
   * assumption that a fleet's zones live beside its units. They do not: the
   * reseller files the two independently, so this table is a record of where
   * things were FOUND and must never be inferred from wialon.account's FLEETS.
   * When a zone is not where you expect, `--find` locates it.
   */
  SUKARI:    { accountId: MENENGAI_WIALON_ACCOUNT_ID,    label: 'Mene-ngai (holds Sukari\'s zones)' },
  WESTSUGAR: { accountId: WEST_SUGAR_REPORT_RESOURCE_ID, label: 'WEST KENYA SUGAR' },
}

const arg = (name: string): string | null => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const APPLY    = process.argv.includes('--apply')
const ORG_CODE = (arg('org') ?? 'KASULU').trim().toUpperCase()
/**
 * Which resource to read, overriding ZONE_SOURCE.
 *
 * Exists because the mapping above is empirical, not structural: "SUKARI
 * INDUSTRIES FACTORY" turned out to live on Mene-ngai's resource rather than
 * beside Sukari's own units. When the next zone is somewhere else again, this
 * is how you point at it without editing the table.
 */
const RESOURCE_OVERRIDE = arg('resource') ? Number(arg('resource')) : null
/** Read-only: search EVERY visible resource for zones matching this text. */
const FIND = (arg('find') ?? '').trim().toLowerCase()
const SHAPES   = (arg('shapes') ?? 'area').trim().toLowerCase()   // 'area' | 'all'
/** Case-insensitive substrings; a zone matching ANY of them is ours. */
const NAME_MASKS = (arg('name') ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)

/** Wialon zone type → ours. */
const ZONE_TYPE = { 1: 'LINE', 2: 'POLYGON', 3: 'CIRCLE' } as const

/**
 * True when a traced polyline returns to its own start — i.e. it is an area
 * boundary, not a corridor.
 *
 * The tolerance is deliberately tight. Wialon writes the closing vertex as a
 * byte-identical copy of the first, so genuine rings measure 0 m; the loosest
 * real corridor in the estate (DRAINS3) still has its endpoints 1,044 m apart.
 * Anything between those two is ambiguous and stays a corridor, because
 * mistaking a river for a polygon is far worse than the reverse: a river's
 * "interior" is meaningless, and every vehicle in the fleet would fall inside
 * the Malagarasi's 62 km hull.
 */
function isClosedRing(pts: Array<[number, number]>, toleranceM = 25): boolean {
  if (pts.length < 4) return false
  const [x1, y1] = pts[0]!
  const [x2, y2] = pts[pts.length - 1]!
  const rad = (d: number) => (d * Math.PI) / 180
  const dx = rad(x2 - x1) * Math.cos(rad((y1 + y2) / 2)) * 6_371_000
  const dy = rad(y2 - y1) * 6_371_000
  return Math.hypot(dx, dy) <= toleranceM
}

/** A Wialon account/resource, with its zone list under `zl` when asked for. */
interface WialonResource { id: number; nm: string; zl?: Record<string, unknown> }

/**
 * Where a fence sits and how big it is, in one line.
 *
 * Hectares via the shoelace formula on a local equirectangular projection —
 * accurate to a fraction of a percent at these sizes, and enough to check an
 * import against what the Wialon UI reports for the same zone.
 */
function describe(d: { type: string; centerLat: number | null; centerLng: number | null; radiusM: number | null; polygonCoords: unknown }): string {
  if (d.type === 'CIRCLE') {
    return `centre ${d.centerLat?.toFixed(5)}, ${d.centerLng?.toFixed(5)} · r ${d.radiusM} m`
  }
  const pts = (d.polygonCoords as [number, number][] | null) ?? []
  if (pts.length === 0) return ''
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const mLat = 111_320, mLng = 111_320 * Math.cos((lat * Math.PI) / 180)
  let twice = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    twice += (pts[j]![0] - pts[i]![0]) * mLng * ((pts[j]![1] + pts[i]![1]) * mLat)
  }
  // The trapezoid form already yields TWICE the area, so it is halved once.
  const ha = Math.abs(twice) / 2 / 10_000
  return `centre ${lat.toFixed(5)}, ${lng.toFixed(5)} · ${ha.toFixed(1)} ha · ${pts.length} pts`
}

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

  // ── --find: where does this zone actually live? ─────────────────────────
  //
  // Read-only, and the answer to the problem this script keeps hitting: the
  // reseller files zones and units on different resources, so "SUKARI
  // INDUSTRIES FACTORY" is on Mene-ngai's. Guessing costs a wrong import into a
  // customer's estate; this costs one API call.
  if (FIND) {
    const client = new WialonClient(TOKEN, API_URL)
    await client.login()
    const res = await client.call<{ items?: WialonResource[] }>('core/search_items', {
      spec: { itemsType: 'avl_resource', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
      force: 1, flags: 1 | 0x1000 | 0x2000 | 0x4000, from: 0, to: 100,
    })
    console.log(`\n🔎  Searching every visible resource for zones matching "${FIND}"\n`)
    let found = 0
    for (const r of res.items ?? []) {
      const zl = Object.values(r.zl ?? {}) as Array<{ id: number; n?: string }>
      const hits = zl.filter(z => (z.n ?? '').toLowerCase().includes(FIND))
      if (hits.length === 0) continue
      found += hits.length
      console.log(`  ${r.id}  "${r.nm}"  — ${hits.length} match(es) of ${zl.length} zones`)
      for (const h of hits.slice(0, 25)) console.log(`      · ${h.n ?? `zone ${h.id}`}`)
      if (hits.length > 25) console.log(`      … and ${hits.length - 25} more`)
    }
    if (!found) console.log('  Nothing matched on any resource this token can see.')
    console.log(`\n  Import with: --org=<ORG> --resource=<id above> --name="${FIND}"\n`)
    await client.logout()
    return
  }

  const source = RESOURCE_OVERRIDE != null
    ? { accountId: RESOURCE_OVERRIDE, label: `--resource override` }
    : ZONE_SOURCE[ORG_CODE]
  if (!source) {
    throw new Error(
      `No zone source for org "${ORG_CODE}". Known: ${Object.keys(ZONE_SOURCE).join(', ')}. ` +
      `Or pass --resource=<id>; --find=<text> locates a zone across all resources.`,
    )
  }
  if (SHAPES !== 'area' && SHAPES !== 'all') {
    throw new Error(`--shapes must be "area" or "all", got "${SHAPES}"`)
  }

  console.log(`\n🔄  Geofence sync — Wialon → org ${ORG_CODE}`)
  console.log(`    resource ${source.accountId} "${source.label}"`)
  console.log(`    shapes: ${SHAPES === 'area' ? 'polygons + circles (corridors skipped)' : 'all, corridors included'}`)
  console.log(`    names:  ${NAME_MASKS.length ? NAME_MASKS.map(m => `"${m}"`).join(' | ') : 'ALL zones on the resource'}`)
  console.log(APPLY ? '    mode:   APPLY — writing\n' : '    mode:   DRY RUN — nothing will be written (pass --apply)\n')

  if (!NAME_MASKS.length && ORG_CODE === 'MENENGAI') {
    console.log('  ⚠  Menengai\'s resource holds thousands of zones and no --name mask was given.')
    console.log('     Every one imported is walked per telemetry ping. Narrow it unless you mean it.\n')
  }

  /**
   * A DRY RUN answers "what is in Wialon", which is not a question about our
   * database — and requiring one means the preview cannot be run from a laptop
   * without the DB tunnel open, which is exactly when you most want to look
   * before you write.
   */
  const org = await prisma.organisation
    .findUnique({ where: { code: ORG_CODE }, select: { id: true } })
    .catch((err: unknown) => {
      if (APPLY) throw err
      const first = String((err as Error).message).split('\n')[0]
      console.log(`  ⚠  No database connection — previewing Wialon only.`)
      console.log(`     (${first})\n`)
      return null
    })
  if (APPLY && !org) throw new Error(`Organisation ${ORG_CODE} not found`)
  const organisationId = org?.id ?? '(dry-run — no org resolved)'

  const client = new WialonClient(TOKEN, API_URL)
  await client.login()

  // Zones hang off the RESOURCE, not the units.
  const res = await client.call<{ items?: WialonResource[] }>(
    'core/search_items',
    {
      spec: { itemsType: 'avl_resource', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
      force: 1, flags: 1 | 0x1000 | 0x2000 | 0x4000, from: 0, to: 100,
    },
  )
  // The RIGHT resource, by id — never `items[0]`.
  //
  // This used to take the first item and worked for exactly as long as the
  // token could see one customer. It can now see eight, sorted by name, and
  // the first is "AQAUMIST LTD" with ZERO zones — so the script had quietly
  // become a no-op that reported success. Its neighbour "Mene-ngai" holds
  // 6,169 zones; one change in Wialon's ordering and those would have been
  // written into KASULU instead. See providers/wialon/wialon.account.
  const resources = res.items ?? []
  const resource = resources.find(r => r.id === source.accountId)
  if (!resource) {
    throw new Error(
      `Wialon resource ${source.accountId} (${ORG_CODE}'s) is not visible to this token. ` +
      `Visible resources: ${resources.map(r => `${r.id} "${r.nm}"`).join(', ') || 'none'}`,
    )
  }

  const zl = Object.values(resource.zl ?? {}) as Array<{ id: number; n?: string }>
  if (zl.length === 0) {
    console.log('  ← the resource holds no geozones — nothing to import.\n')
    return
  }

  /**
   * Narrow by NAME BEFORE fetching the vertices.
   *
   * `resource/get_zone_data` puts the id list in the query string, and
   * Mene-ngai holds 6,169 zones: asking for all of them returned HTTP 414, URI
   * Too Long. The zone list on the resource already carries names, so the mask
   * can be applied here — one zone fetched instead of six thousand.
   *
   * Only when names are actually present, though. A resource that returns ids
   * without names would otherwise match nothing and report an empty import,
   * which looks exactly like "there is nothing there".
   */
  const named = zl.some(z => typeof z.n === 'string')
  const wanted = NAME_MASKS.length && named
    ? zl.filter(z => NAME_MASKS.some(m => (z.n ?? '').toLowerCase().includes(m)))
    : zl
  const zoneIds = wanted.map(z => z.id)

  if (zoneIds.length === 0) {
    console.log(`  ← none of the ${zl.length} zones on this resource match the name mask.`)
    console.log('     Use --find=<text> to see where the zone actually lives.\n')
    return
  }

  // Batched for the same reason: even a matched set can outgrow the URL, and
  // 100 ids per call keeps it comfortably short.
  const CHUNK = 100
  const zones: WialonZone[] = []
  for (let i = 0; i < zoneIds.length; i += CHUNK) {
    // flags 0xFF is the combination that returns vertex data (`p`); narrower
    // flags return only metadata (area/perimeter/bounds).
    const part = await client.call<WialonZone[]>('resource/get_zone_data', {
      itemId: resource.id, col: zoneIds.slice(i, i + CHUNK), flags: 0xFF,
    })
    zones.push(...(part ?? []))
  }
  console.log(`  ← ${zones.length} of ${zl.length} geozones from "${resource.nm}"`)

  let created = 0, updated = 0, skipped = 0, retyped = 0
  const byType: Record<string, number> = {}
  const seen: string[] = []

  let filteredOut = 0, corridorsSkipped = 0
  const wouldImport: string[] = []

  for (const z of zones) {
    const kind = ZONE_TYPE[z.t as 1 | 2 | 3]
    const pts = z.p ?? []
    if (!kind || pts.length === 0) { skipped++; continue }

    // The resource may hold other customers' estates — see ZONE_SOURCE.
    const zoneName = (z.n ?? `Zone ${z.id}`).trim()
    if (NAME_MASKS.length && !NAME_MASKS.some(m => zoneName.toLowerCase().includes(m))) {
      filteredOut++
      continue
    }

    const externalId = `wialon:zone:${z.id}`
    seen.push(externalId)

    // Shared shape; geometry columns filled per type below.
    const base = {
      organisationId,
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

      // A traced polyline that closes on itself is an area boundary the
      // operator drew with the wrong tool — store what it means, not what
      // Wialon called it.
      const isArea = kind === 'POLYGON' || isClosedRing(coords)
      if (isArea && kind === 'LINE') {
        retyped++
        console.log(`    ↻ "${base.name}" — closed ring, importing as POLYGON (Wialon says LINE w=${z.w ?? 1}m)`)
      }

      // A road is not a place to be, and the stranded-stop flag must fire on a
      // unit standing on one. Skipped by default rather than imported and
      // ignored, so what is in the table is what the rule can act on.
      if (!isArea && SHAPES === 'area') {
        corridorsSkipped++
        console.log(`    – "${zoneName}" — corridor, skipped (--shapes=all to import)`)
        continue
      }

      data = isArea
        ? { ...base, type: 'POLYGON', polygonCoords: coords }
        : { ...base, type: 'LINE', polygonCoords: coords, widthM: z.w ?? 1 }
    }

    // Without a database there is nothing to compare against, so everything
    // reads as new — which is the honest answer for a preview.
    const existing = org
      ? await prisma.geofence.findUnique({ where: { externalId }, select: { id: true, isActive: true, mode: true } })
      : null
    if (existing) {
      // Never clobber an enforcement decision already made in our system —
      // re-syncing refreshes geometry and name, not policy.
      const { mode: _m, isActive: _a, ...geometry } = data
      if (APPLY) await prisma.geofence.update({ where: { externalId }, data: geometry })
      updated++
    } else {
      if (APPLY) await prisma.geofence.create({ data: { ...data, externalId } })
      created++
      // WHERE it is, not just what it is called. A preview that only lists
      // names cannot answer the one question worth asking before writing a
      // boundary into a customer's estate — is this the right patch of ground?
      wouldImport.push(`${data.type.padEnd(7)} ${zoneName.padEnd(38)} ${describe(data)}`)
    }
    // Count what we STORED, not what Wialon called it.
    byType[data.type] = (byType[data.type] ?? 0) + 1
  }

  if (wouldImport.length) {
    console.log(`\n  ${APPLY ? 'Imported' : 'Would import'} ${wouldImport.length} new zone(s):`)
    for (const line of wouldImport.slice(0, 40)) console.log(`    + ${line}`)
    if (wouldImport.length > 40) console.log(`    … and ${wouldImport.length - 40} more`)
  }

  const verb = APPLY ? ['created', 'updated'] : ['would create', 'would update']
  console.log(`\n  ${APPLY ? '✓' : '·'} ${verb[0]} ${created}, ${verb[1]} ${updated}, skipped ${skipped} (unsupported or empty geometry)`)
  console.log(`  ${APPLY ? '✓' : '·'} by type: ${Object.entries(byType).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`)
  if (retyped) console.log(`  · ${retyped} closed ring(s) reclassified LINE → POLYGON`)
  if (filteredOut) console.log(`  · ${filteredOut} zone(s) did not match the name mask`)
  if (corridorsSkipped) console.log(`  · ${corridorsSkipped} corridor(s) skipped — roads are not containment`)

  if (org) {
    const active = await prisma.geofence.count({ where: { organisationId: org.id, isActive: true } })
    const bound  = await prisma.vehicleGeofence.count()
    console.log(`\n  ℹ  ${active} fence(s) currently ENFORCED, ${bound} vehicle bindings.`)
    console.log('     Definitions import inactive by design — enforce with npm run geofence:assign.')
  }
  console.log(APPLY ? '' : '\n  DRY RUN — nothing was written. Re-run with --apply to commit.\n')

  await client.logout()
}

main()
  .catch(err => { console.error('\n❌  sync-geofences failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
