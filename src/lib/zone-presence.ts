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
import { publishNotification } from './notifications/notification.store.js'
import { isInsideFence, haversineM, type FenceGeometry } from './geofence.js'
import { categorise, isEstateFeature, ringAreaHa, type ZoneCategory } from './zone-taxonomy.js'

interface CachedZone {
  id:   string
  name: string
  geometry: FenceGeometry
  /** Enforced keep-out zone — entering one is an incident, not an arrival. */
  keepOut: boolean
  category: ZoneCategory
  /**
   * One of OUR surveyed estate features rather than a provider sample point.
   * Only these are ever named to an operator — see lib/zone-taxonomy.
   */
  estate: boolean
  /**
   * Hectares for a polygon, so the SMALLEST containing feature can be picked
   * when several overlap. A vehicle inside FARM#212 is also inside the 2500 Ha
   * Area, and "arrived at FARM#212" is the useful sentence. Null for corridors
   * and circles, which are ranked after polygons.
   */
  areaHa: number | null
}

const zoneCache = new Map<string, { zones: CachedZone[]; loadedAt: number }>()
const ZONE_TTL_MS = 5 * 60_000

/** vehicleId → geofence ids it was inside on the previous frame. */
const presence = new Map<string, Set<string>>()

/**
 * vehicleId → the zone membership the FEED has been told about.
 *
 * Separate from `presence`, which is raw and immediate because containment and
 * keep-out breaches must be. This one lags it by a dwell period so the feed is
 * not narrating boundary noise: several estate polygons abut, and a vehicle
 * parked on a shared edge flipped between "arrived at 2500 Ha Area" and
 * "arrived at FARM #215" every ten minutes without going anywhere. Replayed
 * over real tracks, one vehicle produced twelve such lines in under six hours.
 */
const announced = new Map<string, Set<string>>()

/** vehicleId → zoneId → an unconfirmed change and when it started. */
const pending = new Map<string, Map<string, { inside: boolean; since: number }>>()

/**
 * How long a change has to hold before the feed reports it.
 *
 * Three minutes, the same grace lib/movement-state uses before it will call a
 * journey over — for the same reason. Clipping the corner of a polygon on the
 * way past is not an arrival, and a vehicle straddling a boundary has not left
 * anywhere. A genuine arrival still reports within one dwell of getting there.
 *
 * Applies ONLY to ordinary arrivals and departures. Entering an enforced
 * keep-out zone is announced on the frame it happens, with no delay.
 */
const DWELL_MS = 3 * 60_000

/**
 * How recently a vehicle must have MOVED for a boundary change to count as a
 * crossing.
 *
 * A parked vehicle cannot cross a fence. Its fix still wanders — measured over
 * 12 hours of live crossings, 277 of 2,319 (11.9%) fired while the unit's own
 * telemetry reported a top speed of exactly 0 km/h across a four-minute window
 * around the event. That is GPS drift on a machine standing near a boundary,
 * and it survives DWELL_MS because drift is persistent: it holds the wrong side
 * for minutes at a time, which is precisely what the dwell was built to trust.
 *
 * Not "moving right now", because a vehicle that drives in and parks
 * immediately is a real arrival whose every confirming frame reads zero. It was
 * moving a minute ago; a unit that has stood still for hours was not, and that
 * gap is what this separates.
 *
 * Expressed as DWELL_MS plus ten minutes rather than a flat figure, because the
 * two are coupled: the check runs only AFTER the dwell has elapsed, so any
 * grace shorter than the dwell could never pass, and a grace only slightly
 * longer leaves a park-on-arrival at the mercy of the frame rate. Measured
 * 2026-08-19, frame gaps run p50 28 s and p90 34 s — six frames to satisfy the
 * dwell — but p99 is 905 s, so sparse reporters do exist and a flat five
 * minutes would have silenced their genuine arrivals. Ten minutes of slack past
 * the dwell covers them and still separates a machine parked for hours by a
 * wide margin.
 */
const MOVEMENT_GRACE_MS = DWELL_MS + 10 * 60_000

/**
 * When each vehicle was last seen moving. Keyed by vehicle, bounded by the
 * fleet.
 *
 * A frame with no speed at all leaves no entry and is treated as MOVING at the
 * check below — an absent reading is not evidence of stillness, and failing
 * open keeps a provider that omits speed narrating normally.
 */
const lastMovingAt = new Map<string, number>()

/**
 * vehicleId → the geofence ids ASSIGNED to it (vehicle_geofences).
 *
 * Presence above is computed against every zone in the org, because the feed
 * should narrate any named place a vehicle reaches. Whether that is a BREACH
 * is a different question, and it depends on assignment: a vehicle is only
 * accountable to the zones someone actually attached to it.
 */
const assignmentCache = new Map<string, Set<string>>()
let assignmentsLoadedAt = 0

async function getAssignments(orgId: string): Promise<void> {
  if (Date.now() - assignmentsLoadedAt < ZONE_TTL_MS && assignmentCache.size > 0) return
  const rows = await prisma.vehicleGeofence.findMany({
    where:  { vehicle: { organisationId: orgId } },
    select: { vehicleId: true, geofenceId: true },
  })
  assignmentCache.clear()
  for (const r of rows) {
    let set = assignmentCache.get(r.vehicleId)
    if (!set) { set = new Set(); assignmentCache.set(r.vehicleId, set) }
    set.add(r.geofenceId)
  }
  assignmentsLoadedAt = Date.now()
  logger.debug({ orgId, vehicles: assignmentCache.size, rows: rows.length }, 'Geofence assignment cache loaded')
}

export interface AssignedZoneStatus {
  /** Assigned zones this vehicle is currently inside. */
  inside: Array<{ id: string; name: string; enforced: boolean }>
  /** Inside at least one ENFORCED assigned keep-out zone. */
  breach: boolean
  /** False when we have not evaluated this vehicle yet (no fix seen). */
  known: boolean
}

/**
 * Which of a vehicle's ASSIGNED zones it is currently inside.
 *
 * Every geofence in this deployment is a BLOCKLIST (keep-out) zone, so being
 * inside one is a violation rather than a reassurance — but only 8 of 107 are
 * `isActive`. The rest were bulk-imported from Wialon and never switched on,
 * so they are reported as context (`enforced: false`) and do not raise
 * `breach`. Treating them as live would flood the UI with warnings nobody has
 * chosen to enforce.
 */
export function assignedZoneStatus(orgId: string, vehicleId: string): AssignedZoneStatus {
  const current = presence.get(vehicleId)
  if (!current) return { inside: [], breach: false, known: false }

  const assigned = assignmentCache.get(vehicleId)
  const zones = zoneCache.get(orgId)?.zones ?? []

  const inside: AssignedZoneStatus['inside'] = []
  for (const z of zones) {
    if (!current.has(z.id)) continue
    // No assignment row means the vehicle is not accountable to this zone.
    if (assigned && !assigned.has(z.id)) continue
    inside.push({ id: z.id, name: z.name, enforced: z.keepOut })
  }

  return { inside, breach: inside.some(z => z.enforced), known: true }
}

// A vehicle hovering on a boundary would otherwise flap enter/exit every few
// seconds. Re-announcing the same zone for a vehicle is suppressed for this
// long.
const REANNOUNCE_COOLDOWN_MS = 10 * 60_000
const lastAnnouncedAt = new Map<string, number>()

/**
 * How many containing features to name after the specific one.
 *
 * Two. "Workshop A — inside Nursery A, FARM #215" is a place; adding every
 * enclosing polygon turns the sentence back into the list it replaced.
 */
const CONTEXT_LIMIT = 2

/**
 * Smallest first. A vehicle inside FARM#212 is also inside the 2500 Ha Area,
 * and FARM#212 is the answer to "where is it". Corridors and circles carry no
 * area and sort last — they are not containers.
 */
const bySpecificity = (a: CachedZone, b: CachedZone) =>
  (a.areaHa ?? Infinity) - (b.areaHa ?? Infinity)

/** Beyond this a sample point is not "near" anything and is not quoted. */
const SAMPLE_POINT_MAX_M = 2_000

/**
 * The closest VES sample point, as a cross-reference an operator can look up in
 * Wialon.
 *
 * The VES circles are useless as PLACE NAMES — that is why they no longer lead
 * a feed line — but their centres are real surveyed coordinates, and they are
 * the reference the provider's own alerts speak in. Quoting the nearest one
 * with its distance says something exactly true and lets someone reading our
 * feed find the same spot in Controltech's.
 *
 * It is deliberately NOT presented as a block. `VES 194` and the planting
 * plan's `ZONE 4 - 194` are unrelated numbering schemes: over the 46 numbers
 * the two share, the best similarity fit needs scale 0.381 and rotation 95.6°
 * and still leaves a median 830 m residual against a 400 m block. Printing
 * "block ZONE 4 - VES 194" would invent a correspondence that does not exist.
 */
function nearestSamplePoint(
  zones: CachedZone[], lat: number, lng: number,
): { name: string; distanceM: number } | null {
  let best: { name: string; distanceM: number } | null = null
  for (const z of zones) {
    if (z.estate || z.geometry.type !== 'CIRCLE') continue
    const d = haversineM(lat, lng, z.geometry.centerLat, z.geometry.centerLng)
    if (d > SAMPLE_POINT_MAX_M) continue
    if (!best || d < best.distanceM) best = { name: z.name, distanceM: d }
  }
  return best
}

/** "VES 149 (0.4 km)" / "VES 149 (240 m)" — the unit an operator would use. */
function sampleRef(s: { name: string; distanceM: number } | null): string {
  if (!s) return ''
  const d = s.distanceM < 950
    ? `${Math.round(s.distanceM / 10) * 10} m`
    : `${(s.distanceM / 1000).toFixed(1)} km`
  return `, near ${s.name} (${d})`
}

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
    if (!geometry) continue
    const category = categorise(r.name)
    zones.push({
      id: r.id, name: r.name, geometry,
      keepOut: r.isActive && r.mode === 'BLOCKLIST',
      category,
      estate: isEstateFeature(category),
      areaHa: geometry.type === 'POLYGON' ? ringAreaHa(geometry.polygonCoords) : null,
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
  /**
   * The frame's speed, used to tell a crossing from GPS drift on a parked
   * machine — see MOVEMENT_GRACE_MS. Optional: undefined means the caller
   * cannot say, and the crossing is trusted as before.
   */
  speedKmh?:  number | null
}

/**
 * Compare the vehicle's current zone membership with the previous frame's and
 * publish a feed item for each change. Safe to call on every frame.
 */
export async function trackZonePresence(p: ZonePresenceInput): Promise<void> {
  const { lat, lng } = p
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return

  // The movement clock, stamped before any early return below. "Was this unit
  // moving lately" is a question about the VEHICLE, and the first frame after a
  // restart — the one that seeds presence and announces nothing — carries the
  // speed that proves a subsequent arrival was real. Recording it after that
  // return lost exactly the frame that mattered.
  const at = Date.parse(p.capturedAt) || Date.now()
  if (p.speedKmh != null && p.speedKmh > 0) lastMovingAt.set(p.vehicleId, at)

  const zones = await getZones(p.orgId)
  if (zones.length === 0) return
  await getAssignments(p.orgId)

  const now = new Set<string>()
  for (const z of zones) {
    if (isInsideFence(lat, lng, z.geometry)) now.add(z.id)
  }

  const before = presence.get(p.vehicleId)
  presence.set(p.vehicleId, now)

  // First sighting: record where it is, announce nothing. Without this a
  // restart would report the whole fleet "arriving" where it already was.
  if (!before) return

  const who = p.driverName ? `${p.plate} · ${p.driverName}` : p.plate

  /**
   * Could this vehicle have crossed anything?
   *
   * True when the provider gave no speed at all, so a feed never goes quiet
   * because a frame was thin. `at` can precede the recorded moment when frames
   * arrive out of order, and an absolute difference treats that as recent
   * rather than as centuries of stillness.
   */
  const couldHaveCrossed = (): boolean => {
    if (p.speedKmh == null) return true
    const seen = lastMovingAt.get(p.vehicleId)
    return seen != null && Math.abs(at - seen) <= MOVEMENT_GRACE_MS
  }

  // What the feed currently believes, seeded from the raw set on first sight so
  // a restart does not replay the fleet's existing positions as arrivals.
  let told = announced.get(p.vehicleId)
  if (!told) { told = new Set(before); announced.set(p.vehicleId, told) }
  let waiting = pending.get(p.vehicleId)
  if (!waiting) { waiting = new Map(); pending.set(p.vehicleId, waiting) }

  const entered: CachedZone[] = []
  const exited:  CachedZone[] = []
  const breached: CachedZone[] = []

  for (const z of zones) {
    // Presence above covers EVERY zone, because containment is a different
    // question from narration. Only our own named estate features are worth
    // announcing: the 67 VES sample circles are 1 km across and overlap, so a
    // single vehicle produced half a dozen "arrived at VES 12x" lines a minute
    // naming places no operator recognises. See lib/zone-taxonomy.
    if (!z.estate) continue

    const isIn = now.has(z.id)

    // A keep-out breach is an incident and waits for nothing: it fires on the
    // raw crossing, the frame it happens.
    if (z.keepOut && isIn && !before.has(z.id)) breached.push(z)

    if (isIn === told.has(z.id)) { waiting.delete(z.id); continue }

    // The change is real only once it has held for a dwell — see DWELL_MS.
    const p0 = waiting.get(z.id)
    if (!p0 || p0.inside !== isIn) { waiting.set(z.id, { inside: isIn, since: at }); continue }
    if (at - p0.since < DWELL_MS) continue

    // Held long enough to be real, but only a vehicle that has MOVED can have
    // crossed. Deliberately `continue` WITHOUT clearing the pending entry: the
    // change is still observed and still waiting, so if the unit later drives
    // off it announces then, and if it drifts back the side-flip clears it. A
    // delete here would re-arm the dwell and let drift announce on the next
    // wobble, which is the bug rather than the fix.
    if (!couldHaveCrossed()) continue

    waiting.delete(z.id)

    const key = `${p.vehicleId}:${z.id}:${isIn ? 'in' : 'out'}`
    const last = lastAnnouncedAt.get(key) ?? 0
    if (at - last < REANNOUNCE_COOLDOWN_MS) continue
    lastAnnouncedAt.set(key, at)

    if (isIn) { told.add(z.id); entered.push(z) }
    else      { told.delete(z.id); exited.push(z) }
  }

  if (entered.length === 0 && exited.length === 0 && breached.length === 0) return

  // Live feed + durable history + cache — see notifications/notification.store.
  // Zone crossings are the Live Feed's ONLY narrative for a GPS-only provider
  // like Wialon, so they are the notifications most worth keeping.
  const publish = (
    lead:     CachedZone,
    kind:     'i' | 'o',
    type:     'ZONE_ENTRY' | 'ZONE_EXIT' | 'GEOFENCE_BREACH',
    severity: 'critical' | 'success' | 'info',
    text:     string,
  ) => publishNotification({
    orgId:     p.orgId,
    id:        `zn-${p.vehicleId}-${lead.id}-${kind}-${at}`,
    source:    'zone',
    alertType: type,
    severity,
    text,
    at:        new Date(at),
    plate:     p.plate,
    vehicleId: p.vehicleId,
  })

  // A breach is its own incident and is never folded into an arrival: an
  // operator must be able to see WHICH keep-out zone was entered. It skips the
  // dwell, but still takes the re-announce cooldown — a vehicle working along a
  // drain would otherwise raise a critical alert on every frame.
  // Both messages carry the nearest sample point, because the first thing
  // anyone does with a breach is try to find the vehicle.
  const sample = sampleRef(nearestSamplePoint(zones, lat, lng))

  for (const z of breached) {
    const key = `${p.vehicleId}:${z.id}:breach`
    if (at - (lastAnnouncedAt.get(key) ?? 0) < REANNOUNCE_COOLDOWN_MS) continue
    lastAnnouncedAt.set(key, at)
    publish(z, 'i', 'GEOFENCE_BREACH', 'critical',
      `RESTRICTED: ${who} entered ${z.name} — a keep-out zone${sample}.`)
  }

  // ── One sentence per crossing, not one per zone ──────────────────────────
  //
  // The estate's features nest: a vehicle reaching the workshop is inside
  // Workshop A, Nursery A and FARM #215 all at once, and it used to get a
  // separate "arrived at …" line for each — three notifications describing one
  // event, in arbitrary order, none of them saying where it actually is.
  //
  // So the crossing is reported once, led by the SMALLEST feature entered —
  // the most specific answer to "where is it" — with the larger features that
  // already contain it as context. That context is drawn from where the
  // vehicle is NOW, not from what it just crossed: it was already inside
  // FARM #215 before entering the workshop, and that is exactly the fact which
  // makes the sentence readable.
  const arrivals = entered.filter(z => !z.keepOut).sort(bySpecificity)
  if (arrivals.length > 0) {
    const lead = arrivals[0]!
    // Only AREAS can contain something. A corridor — a haulage road, a drain,
    // a river — is a thing you are ON, and reads as nonsense as context for an
    // arrival, so `areaHa` (polygons only) is the test.
    const within = zones
      .filter(z => z.estate && z.areaHa != null && now.has(z.id) && z.id !== lead.id)
      .filter(z => (z.areaHa ?? 0) > (lead.areaHa ?? 0))
      .sort(bySpecificity)
      .slice(0, CONTEXT_LIMIT)

    const alsoEntered = arrivals.slice(1).filter(z => !within.some(w => w.id === z.id))
    const text = `${who} arrived at ${lead.name}`
      + (within.length > 0 ? ` — inside ${within.map(z => z.name).join(', ')}` : '')
      + (alsoEntered.length > 0 ? ` (also entered ${alsoEntered.map(z => z.name).join(', ')})` : '')
      + sample
      + '.'
    publish(lead, 'i', 'ZONE_ENTRY', 'success', text)
  }

  const departures = exited.sort(bySpecificity)
  if (departures.length > 0) {
    const lead = departures[0]!
    const rest = departures.slice(1)
    // Where it ended up matters more than what it left, when we know it.
    const stillIn = zones
      .filter(z => z.estate && z.areaHa != null && now.has(z.id))
      .sort(bySpecificity)[0]

    const text = `${who} left ${lead.name}`
      + (rest.length > 0 ? ` and ${rest.map(z => z.name).join(', ')}` : '')
      + (stillIn ? ` — now in ${stillIn.name}` : '')
      + '.'
    publish(lead, 'o', 'ZONE_EXIT', 'info', text)
  }
}

export interface EstatePlace {
  id:       string
  name:     string
  category: ZoneCategory
}

/**
 * Which of OUR named estate features a coordinate falls in.
 *
 * This is the calibration step for anything arriving from a provider with its
 * own idea of place. A Wialon notification carries `%ZONE%` — the zone ITS
 * rule fired against, which for this account is almost always one of the VES
 * sample circles — alongside `%LAT%`/`%LON%`. The coordinate is the fact; the
 * zone name is the provider's label for it. So the coordinate is re-resolved
 * against the plotted overlay and the alert is reported against the boundary
 * the operator actually knows: "entered FARM#212", not "entered VES 104".
 *
 * Returns every containing estate feature, most specific first — smallest
 * polygon, then larger polygons, then corridors and circles. A vehicle in
 * FARM#212 is also inside the 2500 Ha Area; both are true and the first is
 * what to lead with.
 *
 * Empty when the point is in no estate feature. Nothing is invented in that
 * case: the alert simply carries no place name, because claiming the nearest
 * boundary would assert a containment that is not there.
 */
export async function resolveEstatePlaces(
  orgId: string,
  lat: number,
  lng: number,
): Promise<EstatePlace[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []

  const zones = await getZones(orgId)
  return zones
    .filter(z => z.estate && isInsideFence(lat, lng, z.geometry))
    .sort((a, b) => (a.areaHa ?? Infinity) - (b.areaHa ?? Infinity))
    .map(z => ({ id: z.id, name: z.name, category: z.category }))
}

/** Drop cached zones for an org — call after a geofence sync. */
export function invalidateZoneCache(orgId?: string): void {
  if (orgId) zoneCache.delete(orgId)
  else zoneCache.clear()
}
