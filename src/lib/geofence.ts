/**
 * Pure geometry helpers — no DB access, no side effects.
 * Circle uses Haversine; polygon uses ray-casting (no external dependency).
 */

const EARTH_RADIUS_M = 6_371_000

/** Haversine distance in metres between two WGS-84 points. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** True if [lng, lat] is inside a GeoJSON-style ring [[lng,lat],...]. */
export function pointInPolygon(
  lat: number,
  lng: number,
  ring: [number, number][],
): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export interface CircleFence {
  type: 'CIRCLE'
  centerLat: number
  centerLng: number
  radiusM: number
}

export interface PolygonFence {
  type: 'POLYGON'
  polygonCoords: [number, number][]
}

export type FenceGeometry = CircleFence | PolygonFence

/** Returns true when the point is INSIDE the fence boundary. */
export function isInsideFence(lat: number, lng: number, fence: FenceGeometry): boolean {
  if (fence.type === 'CIRCLE') {
    return haversineM(lat, lng, fence.centerLat, fence.centerLng) <= fence.radiusM
  }
  return pointInPolygon(lat, lng, fence.polygonCoords)
}
