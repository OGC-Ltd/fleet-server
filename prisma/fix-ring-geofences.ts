/**
 * Backfill — retype closed-ring "corridors" as polygons.
 *
 * The estate's area boundaries (2500 Ha Area, Commercial Area, FARM#210-215,
 * the nurseries, the rainfed block) were traced in Wialon with the polyline
 * tool, so they arrived as type 1 and `sync-geofences` stored them as LINE
 * carrying a 1-3 m width. They are areas: each ring closes exactly on itself,
 * and "2500 Ha Area" encloses ~2,354 ha. As LINE they draw as a hairline on
 * the map and, if ever enforced, would test containment against a one-metre
 * corridor instead of the field.
 *
 * `sync-geofences` now classifies correctly at import, so this is a one-off for
 * rows written before that. It is safe to re-run — it only touches rows that
 * are still mis-typed.
 *
 * Genuine corridors (drains, rivers, haulage roads) have endpoints 1-29 km
 * apart and are left alone. Rows that are ENFORCED are never touched: retyping
 * changes what `isInsideFence` means, and that is not a decision a backfill
 * gets to make silently.
 *
 * Run: npm run fix:rings            (preview)
 *      npm run fix:rings -- --apply (commit)
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const APPLY = process.argv.includes('--apply')

/** Same discriminator the sync uses — see sync-geofences.ts. */
const TOLERANCE_M = 25

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

function closureGapM(pts: Array<[number, number]>): number {
  const [x1, y1] = pts[0]!
  const [x2, y2] = pts[pts.length - 1]!
  const dx = rad(x2 - x1) * Math.cos(rad((y1 + y2) / 2)) * R
  const dy = rad(y2 - y1) * R
  return Math.hypot(dx, dy)
}

/** Shoelace on a local equirectangular projection — hectares. */
function ringAreaHa(pts: Array<[number, number]>): number {
  const lat0 = rad(pts.reduce((s, p) => s + p[1], 0) / pts.length)
  const xy = pts.map(([lng, lat]) => [rad(lng) * Math.cos(lat0) * R, rad(lat) * R] as const)
  let a = 0
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i]!
    const [x2, y2] = xy[(i + 1) % xy.length]!
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2) / 10_000
}

async function main() {
  console.log(`\n🔧  Closed-ring geofence backfill  ${APPLY ? '(APPLYING)' : '(dry run)'}\n`)

  const candidates = await prisma.geofence.findMany({
    where:  { type: 'LINE' },
    select: { id: true, name: true, widthM: true, isActive: true, polygonCoords: true },
    orderBy: { name: 'asc' },
  })

  const rings: typeof candidates = []
  const corridors: Array<{ name: string; gap: number }> = []
  const guarded: string[] = []
  const tooFewPoints: string[] = []

  for (const g of candidates) {
    const pts = g.polygonCoords as unknown as Array<[number, number]> | null
    // Under four vertices there is no ring to speak of — a 2-point drain stub
    // is a corridor by construction. Accounted for explicitly so the report
    // adds up to every LINE row rather than silently dropping some.
    if (!Array.isArray(pts) || pts.length < 4) { tooFewPoints.push(g.name); continue }
    const gap = closureGapM(pts)
    if (gap > TOLERANCE_M) { corridors.push({ name: g.name, gap }); continue }
    if (g.isActive) { guarded.push(g.name); continue }
    rings.push(g)
  }

  console.log(`  Closed rings to retype LINE → POLYGON (${rings.length}):`)
  for (const g of rings) {
    const pts = g.polygonCoords as unknown as Array<[number, number]>
    console.log(
      `    ${g.name.padEnd(42)} pts=${String(pts.length).padStart(5)}` +
      `  w=${String(g.widthM ?? '-').padEnd(4)}  encloses ${ringAreaHa(pts).toFixed(0).padStart(6)} ha`,
    )
  }

  console.log(`\n  Left as corridors (${corridors.length + tooFewPoints.length}):`)
  for (const c of corridors) console.log(`    ${c.name.padEnd(42)} endpoints ${(c.gap / 1000).toFixed(1)} km apart`)
  for (const n of tooFewPoints) console.log(`    ${n.padEnd(42)} open stub, too few vertices to be a ring`)

  console.log(`\n  ${candidates.length} LINE row(s) examined = ${rings.length} ring + ${corridors.length + tooFewPoints.length} corridor + ${guarded.length} guarded`)

  if (guarded.length) {
    console.log(`\n  ⚠  SKIPPED — closed but currently ENFORCED (retype by hand, it changes containment):`)
    for (const n of guarded) console.log(`    ${n}`)
  }

  if (!rings.length) { console.log('\n  Nothing to do.\n'); return }

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with:  npm run fix:rings -- --apply\n')
    return
  }

  for (const g of rings) {
    // widthM is meaningless on a polygon — clear it so nothing downstream
    // mistakes the row for a corridor again.
    await prisma.geofence.update({ where: { id: g.id }, data: { type: 'POLYGON', widthM: null } })
  }

  console.log(`\n  ✓ retyped ${rings.length} ring(s) to POLYGON\n`)
}

main()
  .catch(err => { console.error('\n❌  fix-ring-geofences failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
