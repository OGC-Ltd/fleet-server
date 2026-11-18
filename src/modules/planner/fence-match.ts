/**
 * The database half of fence-pick.ts: the fences near a customer's point.
 */
import { prisma } from '../../lib/prisma.js'
import { pickFence, MATCH_NEAR_M, type NearFence, type FencePick } from './fence-pick.js'

export * from './fence-pick.js'

/** The organisation's fences (not corridors) within MATCH_NEAR_M of a point. */
export async function fencesNear(orgId: string, lat: number, lng: number): Promise<NearFence[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string, name: string, distanceM: number, areaM2: number }>>`
    SELECT id, name,
           ST_Distance(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS "distanceM",
           ST_Area(geom) AS "areaM2"
      FROM geofences
     WHERE organisation_id = ${orgId}
       AND archived_at IS NULL
       AND type <> 'LINE'
       AND geom IS NOT NULL
       AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${MATCH_NEAR_M})
     ORDER BY 3
     LIMIT 40`
  return rows.map((r) => ({ id: r.id, name: r.name, distanceM: Number(r.distanceM), areaM2: Number(r.areaM2) }))
}

/** pickFence for each customer that needs a fence, by customer code. */
export async function fencePicks(orgId: string, wants: Array<{ code: string, name: string, lat: number, lng: number }>) {
  const out = new Map<string, FencePick>()
  await Promise.all(wants.map(async (w) => {
    out.set(w.code, pickFence(w.name, await fencesNear(orgId, w.lat, w.lng)))
  }))
  return out
}
