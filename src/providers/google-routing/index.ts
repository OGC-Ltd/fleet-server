/**
 * Google Routes API (computeRoutes, computeRouteMatrix) and Roads API, server-side.
 * (The Isochrones API was removed on request, 2026-10-19.)
 *
 * Every call takes a point the server already holds — the
 * unit's latest Wialon fix — so no phone, app or driver is involved, which is
 * the whole reason this was chosen over Navigation Connect (see
 * docs/navigation-connect-plan.md, on hold).
 *
 * The key is GOOGLE_ROUTING_API_KEY, never the browser's Maps key: that one is
 * restricted by HTTP referrer and Google refuses it from a server.
 */

import { env } from '../../config/env.js'

export interface LatLng { lat: number; lng: number }

export interface RoadRoute {
  /** [lat, lng] vertices from origin to destination. */
  path: [number, number][]
  distanceM: number
  /** With live traffic. */
  durationS: number
  /** The same roads with no traffic — the gap is the delay traffic adds. */
  staticDurationS: number
}

export class GoogleRoutingError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function googleRoutingAvailable(): boolean {
  return env.GOOGLE_ROUTING_ENABLED && env.GOOGLE_ROUTING_API_KEY.length > 0
}

const TIMEOUT_MS = 10_000

async function post<T>(url: string, body: unknown, fieldMask?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.GOOGLE_ROUTING_API_KEY,
      ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    // Google's error body names the cause ("API not enabled", "key invalid");
    // pass its message on rather than a bare status.
    let detail = ''
    try {
      const j = await res.json() as { error?: { message?: string } }
      detail = j.error?.message ?? ''
    } catch { /* not JSON */ }
    throw new GoogleRoutingError(detail || `Google returned ${res.status}`, res.status)
  }
  return res.json() as Promise<T>
}

/** "1234s" / "1234.5s" → 1234.5. Google's protobuf Duration as JSON. */
export function parseDuration(d: string | undefined): number {
  if (!d) return 0
  const n = parseFloat(d)
  return Number.isFinite(n) ? n : 0
}

/** Google's encoded polyline (precision 5) → [lat, lng][]. */
export function decodePolyline(encoded: string): [number, number][] {
  const out: [number, number][] = []
  let i = 0, lat = 0, lng = 0
  while (i < encoded.length) {
    for (const which of [0, 1] as const) {
      let shift = 0, result = 0, b: number
      do {
        b = encoded.charCodeAt(i++) - 63
        result |= (b & 0x1f) << shift
        shift += 5
      } while (b >= 0x20)
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (which === 0) lat += delta
      else lng += delta
    }
    out.push([lat / 1e5, lng / 1e5])
  }
  return out
}

const waypoint = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } })

/** Driving route with live traffic. Null when Google finds no road between them. */
export async function computeRoute(origin: LatLng, destination: LatLng): Promise<RoadRoute | null> {
  const j = await post<{
    routes?: { distanceMeters?: number; duration?: string; staticDuration?: string; polyline?: { encodedPolyline?: string } }[]
  }>(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      origin: waypoint(origin),
      destination: waypoint(destination),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      polylineQuality: 'OVERVIEW',
    },
    'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline',
  )
  const r = j.routes?.[0]
  if (!r?.polyline?.encodedPolyline) return null
  return {
    path: decodePolyline(r.polyline.encodedPolyline),
    distanceM: r.distanceMeters ?? 0,
    durationS: parseDuration(r.duration),
    staticDurationS: parseDuration(r.staticDuration ?? r.duration),
  }
}

/** How a vehicle moves, as Google names it. Lorries and tractors drive. */
export type TravelMode = 'DRIVE' | 'TWO_WHEELER'

/** Google's Roads API takes at most this many points a request. */
export const SNAP_BATCH = 100

/**
 * Roads API snapToRoads: recorded fixes matched to the roads they most likely
 * lie on, with the road's shape filled in between (`interpolate`).
 *
 * A computed line, never the record: the caller keeps the raw fixes beside it.
 * Batches of 100 overlap by one point so the line is continuous; a point the
 * previous batch already returned is dropped at the seam.
 */
export async function snapToRoads(points: LatLng[]): Promise<[number, number][]> {
  if (points.length < 2) return []
  const out: [number, number][] = []
  for (let start = 0; start < points.length - 1; start += SNAP_BATCH - 1) {
    const chunk = points.slice(start, start + SNAP_BATCH)
    const url = new URL('https://roads.googleapis.com/v1/snapToRoads')
    url.searchParams.set('path', chunk.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|'))
    url.searchParams.set('interpolate', 'true')
    url.searchParams.set('key', env.GOOGLE_ROUTING_API_KEY)
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const j = await res.json().catch(() => ({})) as {
      snappedPoints?: { location?: { latitude?: number; longitude?: number } }[]
      error?: { message?: string }
    }
    if (!res.ok) throw new GoogleRoutingError(j.error?.message || `Google returned ${res.status}`, res.status)
    const pts = (j.snappedPoints ?? [])
      .map((p) => [p.location?.latitude, p.location?.longitude] as [number, number])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    if (start > 0 && pts.length) pts.shift()
    out.push(...pts)
  }
  return out
}

export interface MatrixCell {
  /** Index into the origins given. */
  index: number
  /** Live-traffic drive time and the same drive with no traffic, seconds. */
  durationS: number
  staticDurationS: number
  distanceM: number
}

/** Google refuses a TRAFFIC_AWARE matrix of more than this many cells. */
export const MATRIX_MAX = 100

/**
 * Routes API computeRouteMatrix: many origins to ONE destination, with live
 * traffic — every unit's drive time to a hub in one request. A unit with no
 * road to it is left out; the caller reads the missing index as "no route".
 */
export async function routeMatrixTo(origins: LatLng[], destination: LatLng, mode: TravelMode = 'DRIVE'): Promise<MatrixCell[]> {
  if (!origins.length) return []
  if (origins.length > MATRIX_MAX) throw new GoogleRoutingError(`At most ${MATRIX_MAX} origins a request`, 400)
  const rows = await post<{
    originIndex?: number; duration?: string; staticDuration?: string; distanceMeters?: number; condition?: string
  }[]>(
    'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
    {
      origins: origins.map((p) => ({ waypoint: waypoint(p) })),
      destinations: [{ waypoint: waypoint(destination) }],
      travelMode: mode,
      routingPreference: 'TRAFFIC_AWARE',
    },
    'originIndex,duration,staticDuration,distanceMeters,condition',
  )
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.condition === 'ROUTE_EXISTS' && r.originIndex != null)
    .map((r) => ({
      index: r.originIndex ?? 0,
      durationS: parseDuration(r.duration),
      staticDurationS: parseDuration(r.staticDuration ?? r.duration),
      distanceM: r.distanceMeters ?? 0,
    }))
}
