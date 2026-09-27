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

/**
 * A CORRIDOR: a path with a width, the shape Wialon calls a "line" zone.
 * Haulage roads, drains and rivers are drawn this way — a vehicle is inside
 * when it is within `widthM / 2` of the centre-line.
 */
export interface CorridorFence {
  type: 'LINE'
  /** Centre-line vertices as [lng, lat], matching PolygonFence's ordering. */
  pathCoords: [number, number][]
  /** Full corridor width in metres; half of it is the distance tolerance. */
  widthM: number
}

export type FenceGeometry = CircleFence | PolygonFence | CorridorFence

/**
 * Shortest distance in metres from a point to a line segment.
 *
 * Works in a local planar approximation: within a few kilometres — the scale
 * of every corridor here — projecting degrees onto metres with a cos(lat)
 * correction on longitude is accurate to well under a metre, and avoids the
 * cost and complexity of a spherical cross-track calculation per segment.
 */
const M_PER_DEG_LAT = 111_320

function distanceToSegmentM(
  lat: number, lng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

  const px = (lng - aLng) * mPerDegLng
  const py = (lat - aLat) * M_PER_DEG_LAT
  const bx = (bLng - aLng) * mPerDegLng
  const by = (bLat - aLat) * M_PER_DEG_LAT

  const lenSq = bx * bx + by * by
  if (lenSq === 0) return Math.hypot(px, py)         // degenerate segment

  // Projection of P onto AB, clamped to the segment.
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lenSq))
  return Math.hypot(px - t * bx, py - t * by)
}

/** True when the point lies within half the corridor width of its centre-line. */
export function isInsideCorridor(
  lat: number, lng: number,
  pathCoords: [number, number][],
  widthM: number,
): boolean {
  if (pathCoords.length === 0) return false
  const tolerance = Math.max(widthM, 1) / 2
  if (pathCoords.length === 1) {
    const [lng0, lat0] = pathCoords[0]!
    return haversineM(lat, lng, lat0, lng0) <= tolerance
  }
  // A segment whose extent, widened by the tolerance, misses the point cannot
  // be within the tolerance of it — in the same flat metres distanceToSegmentM
  // measures in — so it is passed over without the arithmetic. The answer is
  // unchanged; a long road corridor stops costing one projection per segment
  // for every reading near it (MUFINDI: EX 10, 27 Sep: 2,316 readings against
  // 97 zones took 1.0 s, nearly all of it here and in the zone loop).
  const padLat = (tolerance / M_PER_DEG_LAT) * 1.000001
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
  const padLng = mPerDegLng > 0 ? (tolerance / mPerDegLng) * 1.000001 : Infinity
  for (let i = 1; i < pathCoords.length; i++) {
    const [aLng, aLat] = pathCoords[i - 1]!
    const [bLng, bLat] = pathCoords[i]!
    if (lat < Math.min(aLat, bLat) - padLat || lat > Math.max(aLat, bLat) + padLat) continue
    if (lng < Math.min(aLng, bLng) - padLng || lng > Math.max(aLng, bLng) + padLng) continue
    if (distanceToSegmentM(lat, lng, aLat, aLng, bLat, bLng) <= tolerance) return true
  }
  return false
}

/** Latitude and longitude bounds, in degrees. */
export interface FenceBox { minLat: number; maxLat: number; minLng: number; maxLng: number }

/** Fewer metres than a degree of latitude ever spans, so margins built on it err wide. */
const M_PER_DEG_FLOOR = 110_000

/**
 * A box no point inside the fence lies outside of — the cheap first test
 * before `isInsideFence`, for code that asks the same fences about many points.
 *
 * A polygon's box is its corners' extent, exactly: ray-casting can only call a
 * point inside that is within it. A circle's and a corridor's edges are metres
 * from a centre, so their boxes are widened by that reach half again over,
 * converted on a short degree and at the box's poleward edge, where a degree
 * of longitude is shortest. Never too small; a little large is only a wasted
 * exact test.
 */
export function fenceBox(fence: FenceGeometry): FenceBox {
  const pts: [number, number][] = fence.type === 'CIRCLE'
    ? [[fence.centerLng, fence.centerLat]]
    : fence.type === 'LINE' ? fence.pathCoords : fence.polygonCoords
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  for (const [lng, lat] of pts) {
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
  }
  const reach = fence.type === 'CIRCLE' ? fence.radiusM
    : fence.type === 'LINE' ? Math.max(fence.widthM, 1) / 2 : 0
  if (!(reach > 0) || !Number.isFinite(minLat)) return { minLat, maxLat, minLng, maxLng }
  const dLat = (reach * 1.5) / M_PER_DEG_FLOOR
  const poleward = Math.min(89, Math.max(Math.abs(minLat), Math.abs(maxLat)) + dLat)
  const dLng = (reach * 1.5) / (M_PER_DEG_FLOOR * Math.cos((poleward * Math.PI) / 180))
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLng: minLng - dLng, maxLng: maxLng + dLng }
}

/** True when the point is within the box — see fenceBox. */
export function inBox(box: FenceBox, lat: number, lng: number): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng
}

/** Returns true when the point is INSIDE the fence boundary. */
export function isInsideFence(lat: number, lng: number, fence: FenceGeometry): boolean {
  if (fence.type === 'CIRCLE') {
    return haversineM(lat, lng, fence.centerLat, fence.centerLng) <= fence.radiusM
  }
  if (fence.type === 'LINE') {
    return isInsideCorridor(lat, lng, fence.pathCoords, fence.widthM)
  }
  return pointInPolygon(lat, lng, fence.polygonCoords)
}
