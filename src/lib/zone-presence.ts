/**
 * Zone-transition feed events.
 *
 * The Live Feed used to be narrated by the simulator's `_sim.phase` changes
 * (dispatched → en route → arrived → offloading). Real telemetry carries no
 * such story: a Wialon frame is a position and a speed. Left as-is, an org fed
 * only by GPS has a permanently empty feed even though its fleet is visibly
 * moving on the map.
 *
 * What we DO have is the customer's own named geofences — factory site,
 * logistics centres, workshops, farms, haulage roads — plus a position every
 * couple of seconds. Crossing into or out of one of those is a real,
 * observable operational event, so that is what the feed reports. Nothing is
 * inferred beyond "this coordinate is inside this named polygon".
 *
 * Design notes:
 *  • Zones are cached per org and evaluated IN MEMORY. Binding all 107 zones
 *    to all 224 vehicles and querying per ping would be thousands of rows per
 *    poll cycle; point-in-polygon over a cached list is microseconds.
 *  • ALL zones are considered, not just enforced ones. Enforcement decides
 *    what raises a violation; presence is just context, and a vehicle arriving
 *    at the workshop is worth reporting whether or not that zone is policed.
 *  • The first frame for a vehicle only seeds its presence set — otherwise a
 *    restart would announce every vehicle "entering" wherever it already sits.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { emitDashboardFeed } from './sse.js'
import { isInsideFence, type FenceGeometry } from './geofence.js'

interface CachedZone {
  id:   string
  name: string
  geometry: FenceGeometry
  /** Enforced keep-out zone — entering one is an incident, not an arrival. */
  keepOut: boolean
}

const zoneCache = new Map<string, { zones: CachedZone[]; loadedAt: number }>()
const ZONE_TTL_MS = 5 * 60_000

/** vehicleId → geofence ids it was inside on the previous frame. */
const presence = new Map<string, Set<string>>()

// A vehicle hovering on a boundary would otherwise flap enter/exit every few
// seconds. Re-announcing the same zone for a vehicle is suppressed for this
// long.
const REANNOUNCE_COOLDOWN_MS = 10 * 60_000
const lastAnnouncedAt = new Map<string, number>()

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

function toGeometry(f: {
  type: string; centerLat: number | null; centerLng: number | null; radiusM: number | null
  polygonCoords: unknown; widthM: number | null
}): FenceGeometry | null {
  if (f.type === 'CIRCLE') {
    if (f.centerLat == null || f.centerLng == null || f.radiusM == null) return null
    return { type: 'CIRCLE', centerLat: f.centerLat, centerLng: f.centerLng, radiusM: f.radiusM }
  }
  if (f.type === 'LINE') {
    if (!f.polygonCoords || f.widthM == null) return null
    return { type: 'LINE', pathCoords: f.polygonCoords as [number, number][], widthM: f.widthM }
  }
  if (!f.polygonCoords) return null
  return { type: 'POLYGON', polygonCoords: f.polygonCoords as [number, number][] }
}

async function getZones(orgId: string): Promise<CachedZone[]> {
  const hit = zoneCache.get(orgId)
  if (hit && Date.now() - hit.loadedAt < ZONE_TTL_MS) return hit.zones

  const rows = await prisma.geofence.findMany({
    where:  { organisationId: orgId },
    select: {
      id: true, name: true, type: true, mode: true, isActive: true,
      centerLat: true, centerLng: true, radiusM: true, polygonCoords: true, widthM: true,
    },
  })

  const zones: CachedZone[] = []
  for (const r of rows) {
    const geometry = toGeometry(r)
    if (geometry) zones.push({
      id: r.id, name: r.name, geometry,
      keepOut: r.isActive && r.mode === 'BLOCKLIST',
    })
  }
  zoneCache.set(orgId, { zones, loadedAt: Date.now() })
  logger.debug({ orgId, zones: zones.length }, 'Zone cache loaded')
  return zones
}

export interface ZonePresenceInput {
  orgId:      string
  vehicleId:  string
  plate:      string
  driverName: string | null | undefined
  /** Null when the frame carried no fix — nothing to evaluate. */
  lat:        number | null
  lng:        number | null
  capturedAt: string
}

/**
 * Compare the vehicle's current zone membership with the previous frame's and
 * publish a feed item for each change. Safe to call on every frame.
 */
export async function trackZonePresence(p: ZonePresenceInput): Promise<void> {
  const { lat, lng } = p
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return

  const zones = await getZones(p.orgId)
  if (zones.length === 0) return

  const now = new Set<string>()
  for (const z of zones) {
    if (isInsideFence(lat, lng, z.geometry)) now.add(z.id)
  }

  const before = presence.get(p.vehicleId)
  presence.set(p.vehicleId, now)

  // First sighting: record where it is, announce nothing. Without this a
  // restart would report the whole fleet "arriving" where it already was.
  if (!before) return

  const at = Date.parse(p.capturedAt) || Date.now()
  const who = p.driverName ? `${p.plate} · ${p.driverName}` : p.plate

  for (const z of zones) {
    const isIn = now.has(z.id)
    const wasIn = before.has(z.id)
    if (isIn === wasIn) continue

    const key = `${p.vehicleId}:${z.id}:${isIn ? 'in' : 'out'}`
    const last = lastAnnouncedAt.get(key) ?? 0
    if (at - last < REANNOUNCE_COOLDOWN_MS) continue
    lastAnnouncedAt.set(key, at)

    // Entering an enforced keep-out zone is an incident; everything else is
    // ordinary movement worth narrating.
    const type = isIn && z.keepOut ? 'critical' : isIn ? 'success' : 'info'
    const text = isIn
      ? (z.keepOut
          ? `RESTRICTED: ${who} entered ${z.name} — a keep-out zone.`
          : `${who} arrived at ${z.name}.`)
      : `${who} left ${z.name}.`

    emitDashboardFeed(p.orgId, {
      id:        `zn-${p.vehicleId}-${z.id}-${isIn ? 'i' : 'o'}-${at}`,
      time:      clockFmt.format(at),
      ts:        new Date(at).toISOString(),
      type,
      text,
      source:    'zone',
      alertType: isIn ? (z.keepOut ? 'GEOFENCE_BREACH' : 'ZONE_ENTRY') : 'ZONE_EXIT',
      plate:     p.plate,
      vehicleId: p.vehicleId,
      zone:      z.name,
    })
  }
}

/** Drop cached zones for an org — call after a geofence sync. */
export function invalidateZoneCache(orgId?: string): void {
  if (orgId) zoneCache.delete(orgId)
  else zoneCache.clear()
}
