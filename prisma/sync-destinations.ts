/**
 * Measure where dispatch destinations ARE, and where the yard is.
 *
 * ## Why this exists
 *
 * RaiFactorySuite records a dispatch's destination as free text — 152 distinct
 * cane-zone names in use ("OPAPO", "NYAONDO", "GOT KOJOWI") — and no
 * coordinates. Nothing downstream could therefore say how far a trip is, how
 * far along it is, or whether the unit ever arrived. Geocoding the names was
 * tried and abandoned: probing Nominatim on the fourteen busiest returned five
 * matches, three of them plainly wrong (a primary school 20 km away, a road
 * 25 km away).
 *
 * The fleet already answered the question, though. Every COMPLETED dispatch is
 * a round trip with a known start and end clock, and the vehicle reported its
 * position throughout. The fix FARTHEST from the yard between those two clocks
 * is the turn-around — which is the destination, measured by the truck that
 * went there. Take the median of that point across every completed trip to the
 * same name and the noise of any one run falls away.
 *
 * ## How much to trust a row
 *
 * Every row carries `samples` and `spreadM`, and callers are expected to look:
 *
 *   samples   completed trips that agreed on the point.
 *   spreadM   median distance from one trip's own turn-around to the consensus.
 *
 * A tight spread means a place. A wide one means the name covers a ZONE with no
 * single point — real in this data: OSOGO KAJ's trips scatter over 5.5 km —
 * and drawing it as a pin, or measuring progress against it, would be a lie.
 * MAX_SPREAD_M is where this script stops writing a row at all.
 *
 * ## Validation
 *
 * On 2026-08-03 the operator supplied a surveyed coordinate for the Nyaondo
 * weighbridge (-0.9105393, 34.6133987). This method, told nothing, put NYAONDO
 * 83 m away from it off 39 trips with a 0.1 km spread. That is the evidence the
 * approach works; re-check it if the derivation is ever changed.
 *
 * ## The hub
 *
 * Measured the same way and for the same reason: the provider records no origin
 * for a dispatch, so "where did it leave from" has no source but the fleet
 * itself. It is the densest cell of recent fixes — for SUKARI, 36k fixes from
 * 148 vehicles inside ~110 m. Written to organisations.hub_lat/hub_lng.
 *
 * Idempotent, and safe to re-run: rows upsert on (organisationId, name).
 *
 * Run: npm run sync:destinations  [-- --org=SUKARI] [-- --days=120] [-- --dry]
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const arg = (name: string) =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
const DRY  = process.argv.includes('--dry')
const DAYS = Number(arg('days') ?? 120)
const ONLY_ORG = arg('org')?.toUpperCase()

/**
 * Beyond this the name does not describe a point.
 *
 * 2 km is not arbitrary: the tight destinations in the live data sit at
 * 0.1–0.4 km and the diffuse ones jump to 1.4 km and beyond, so the gap is
 * where the two populations separate. A rejected name still works everywhere —
 * it simply shows as text with no distance, which is the honest rendering.
 */
const MAX_SPREAD_M = 2_000

/** Fewer trips than this and the median is one truck's opinion. */
const MIN_SAMPLES = 3

const R_EARTH_M = 6_371_000
function haversineM(a: Pt, b: Pt): number {
  const r = Math.PI / 180
  const dLat = (b.lat - a.lat) * r
  const dLng = (b.lng - a.lng) * r
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h))
}

interface Pt { lat: number; lng: number }

/**
 * Median, not mean, on both axes.
 *
 * One trip that carried on somewhere else afterwards, or one bad fix in the
 * lake, drags a mean kilometres off. The median simply ignores it — and with a
 * cluster this tight the two agree anyway when the data is clean, so the
 * difference only ever shows up when it matters.
 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * The yard: the densest ~110 m cell of the org's recent fixes.
 *
 * Rounding to 3 decimals buckets fixes into a grid, and the yard wins by an
 * order of magnitude because every vehicle passes through it. Returns the mean
 * position INSIDE the winning cell, so the answer is not snapped to the grid.
 */
async function measureHub(organisationId: string): Promise<(Pt & { fixes: number; vehicles: number }) | null> {
  const rows = await prisma.$queryRaw<{
    lat: number; lng: number; fixes: bigint; vehicles: bigint
  }[]>`
    SELECT avg(t.lat)::float AS lat, avg(t.lng)::float AS lng,
           count(*) AS fixes, count(DISTINCT t.vehicle_id) AS vehicles
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${organisationId}
       AND t.captured_at > now() - interval '7 days'
       AND t.lat IS NOT NULL AND t.lng IS NOT NULL
     GROUP BY round(t.lat::numeric, 3), round(t.lng::numeric, 3)
     ORDER BY count(*) DESC
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return { lat: r.lat, lng: r.lng, fixes: Number(r.fixes), vehicles: Number(r.vehicles) }
}

/**
 * One turn-around point per completed dispatch.
 *
 * The distance is computed in SQL and the ORDER BY … LIMIT 1 runs inside a
 * LATERAL, so each dispatch walks its own vehicle's `(vehicle_id, captured_at)`
 * range and keeps one row. Pulling the fixes into Node instead would move
 * millions of rows to compute a few hundred points.
 */
async function turnarounds(organisationId: string, hub: Pt) {
  return prisma.$queryRawUnsafe<{ dest: string; lat: number; lng: number }[]>(`
    WITH done AS (
      SELECT id, vehicle_id, upper(trim(destination)) AS dest,
             dispatched_at, actual_return_at
        FROM dispatches
       WHERE organisation_id  = $1
         AND vehicle_id       IS NOT NULL
         AND destination      IS NOT NULL
         AND actual_return_at IS NOT NULL
         -- Guard the provider's own bad rows: a return stamped before the
         -- dispatch would make the window empty, or worse, inverted.
         AND actual_return_at > dispatched_at
         AND actual_return_at > now() - ($4 || ' days')::interval
    )
    SELECT d.dest, f.lat, f.lng
      FROM done d
      JOIN LATERAL (
        SELECT t.lat, t.lng,
               2 * 6371 * asin(sqrt(
                 power(sin(radians(t.lat - $2) / 2), 2) +
                 cos(radians($2)) * cos(radians(t.lat)) *
                 power(sin(radians(t.lng - $3) / 2), 2))) AS d_km
          FROM vehicle_telemetries t
         WHERE t.vehicle_id  = d.vehicle_id
           AND t.lat IS NOT NULL AND t.lng IS NOT NULL
           AND t.captured_at BETWEEN d.dispatched_at AND d.actual_return_at
         ORDER BY d_km DESC
         LIMIT 1
      ) f ON true
  `, organisationId, hub.lat, hub.lng, String(DAYS))
}

async function run() {
  const orgs = await prisma.organisation.findMany({
    where:  ONLY_ORG ? { code: ONLY_ORG } : {},
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  })
  if (orgs.length === 0) {
    console.error(ONLY_ORG ? `No organisation with code ${ONLY_ORG}` : 'No organisations')
    process.exitCode = 1
    return
  }

  for (const org of orgs) {
    console.log(`\n=== ${org.code} ===`)

    const hub = await measureHub(org.id)
    if (!hub) {
      console.log('  no telemetry in the last 7 days — skipped (nothing to measure a hub or a destination from)')
      continue
    }
    console.log(`  hub: ${hub.lat.toFixed(6)}, ${hub.lng.toFixed(6)}  (${hub.fixes} fixes, ${hub.vehicles} vehicles)`)
    if (!DRY) {
      await prisma.organisation.update({
        where: { id: org.id },
        data:  { hubLat: hub.lat, hubLng: hub.lng },
      })
    }

    const points = await turnarounds(org.id, hub)
    if (points.length === 0) {
      console.log('  no completed dispatches with telemetry in the window — no destinations to derive')
      continue
    }

    const byName = new Map<string, Pt[]>()
    for (const p of points) {
      if (!byName.has(p.dest)) byName.set(p.dest, [])
      byName.get(p.dest)!.push({ lat: Number(p.lat), lng: Number(p.lng) })
    }

    let written = 0, tooFew = 0, tooDiffuse = 0
    const rejected: string[] = []

    for (const [name, pts] of [...byName.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (pts.length < MIN_SAMPLES) { tooFew++; continue }

      const centre: Pt = { lat: median(pts.map(p => p.lat)), lng: median(pts.map(p => p.lng)) }
      const spreadM = Math.round(median(pts.map(p => haversineM(p, centre))))
      if (spreadM > MAX_SPREAD_M) {
        tooDiffuse++
        rejected.push(`${name} (${pts.length} trips, ${(spreadM / 1000).toFixed(1)} km apart)`)
        continue
      }

      const distanceFromHubM = Math.round(haversineM(centre, hub))
      console.log(
        `  ${name.padEnd(22)} ${String(pts.length).padStart(3)} trips  ` +
        `${centre.lat.toFixed(5)}, ${centre.lng.toFixed(5)}  ` +
        `±${String(spreadM).padStart(4)} m  ${(distanceFromHubM / 1000).toFixed(1)} km out`,
      )

      if (!DRY) {
        const row = {
          lat: centre.lat, lng: centre.lng,
          samples: pts.length, spreadM, distanceFromHubM,
          computedAt: new Date(),
        }
        await prisma.dispatchDestination.upsert({
          where:  { organisationId_name: { organisationId: org.id, name } },
          create: { organisationId: org.id, name, ...row },
          // Re-derived on every run: more completed trips land continuously, so
          // a point sharpens over time and a row is expected to change.
          update: row,
        })
      }
      written++
    }

    console.log(
      `  ${written} destination(s) ${DRY ? 'would be ' : ''}written; ` +
      `${tooFew} under ${MIN_SAMPLES} trips, ${tooDiffuse} too spread out to be a point`,
    )
    if (rejected.length) console.log(`  spread out: ${rejected.join(', ')}`)
  }
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
