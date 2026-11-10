/**
 * The stop watch's rules: Menengai's units standing where they should not
 * (operator, 5 Nov 2026: "any stop longer than 10 minutes outside the
 * RestStops, Customers, Sites and weighbridges"; no-go zones after 2 minutes).
 *
 * Ported from new-ui lib/stopWatch (flaggedUnits), which ran in every open
 * browser until 10 Nov 2026; the server now decides once for everybody
 * (stop-watch.service). Pure: no database, no network.
 */

import { haversineM, pointInPolygon } from '../../lib/geofence.js'

export const ORG_CODE = 'MENENGAI'
export const NOGO_MIN_MS = 2 * 60_000
export const UNAUTHORISED_MIN_MS = 10 * 60_000
/** A position older than this is not judged: the unit may have moved since. */
export const STALE_MS = 6 * 3_600_000
/** Standing: slower than this (km/h), and not moving by the movement state. */
const STAND_KMH = 3

export interface PlaceFeature {
  properties?: { name?: unknown; radiusM?: unknown; category?: unknown; type?: unknown } | null
  geometry?: { type: string; coordinates: unknown } | null
}

interface Box { minLat: number; maxLat: number; minLng: number; maxLng: number }
export interface Place { name: string; category: string; feature: PlaceFeature; box: Box }

/** MORL and the Nairobi depot (STO), 1 km round each, as the Deliveries Report has them. */
const STORES: PlaceFeature[] = [
  { properties: { name: 'MORL', radiusM: 1000, category: 'factory' }, geometry: { type: 'Point', coordinates: [36.04494759379902, -0.28802969095623043] } },
  { properties: { name: 'STO (Nairobi depot)', radiusM: 1000, category: 'storage' }, geometry: { type: 'Point', coordinates: [36.8660916, -1.3029466] } },
]

/** The places file's types as the map's categories (new-ui lib/zoneLegend). */
const FILE_TYPES: Record<string, string> = { Customer: 'customer', RestStop: 'parking', Site: 'facility', Other: 'weighing', NoGoZone: 'restricted' }

type Ring = [number, number][]

function ringsOf(g: PlaceFeature['geometry']): Ring[][] | null {
  if (!g) return null
  if (g.type === 'Polygon') return [g.coordinates as Ring[]]
  if (g.type === 'MultiPolygon') return g.coordinates as Ring[][]
  return null
}

function boxOf(f: PlaceFeature): Box | null {
  const g = f.geometry
  if (!g) return null
  if (g.type === 'Point') {
    const [lng, lat] = g.coordinates as number[]
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const r = (Number(f.properties?.radiusM) || 0) / 111_000 + 0.0005
    const rl = r / Math.cos((lat! * Math.PI) / 180)
    return { minLat: lat! - r, maxLat: lat! + r, minLng: lng! - rl, maxLng: lng! + rl }
  }
  const polys = ringsOf(g)
  if (!polys?.length) return null
  let minLat = Infinity; let maxLat = -Infinity; let minLng = Infinity; let maxLng = -Infinity
  for (const poly of polys) for (const [lng, lat] of poly[0] ?? []) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
  }
  return Number.isFinite(minLat) ? { minLat, maxLat, minLng, maxLng } : null
}

/** Places ready to test, each with its box for a quick first look. Roads (LineStrings) are not places. */
export function placesOf(features: readonly PlaceFeature[] | null | undefined): Place[] {
  const out: Place[] = []
  for (const f of features ?? []) {
    const box = boxOf(f)
    if (!box) continue
    const p = f.properties ?? {}
    const category = typeof p.category === 'string' ? p.category : FILE_TYPES[String(p.type)] ?? 'other'
    out.push({ name: String(p.name ?? '').trim() || 'Unnamed', category, feature: f, box })
  }
  return out
}
export const storePlaces = (): Place[] => placesOf(STORES)

const inBox = (lat: number, lng: number, b: Box) => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng

function contains(lat: number, lng: number, f: PlaceFeature): boolean {
  const g = f.geometry
  if (!g) return false
  if (g.type === 'Point') {
    const r = Number(f.properties?.radiusM)
    const [zlng, zlat] = g.coordinates as number[]
    return Number.isFinite(r) && r > 0 && haversineM(lat, lng, zlat!, zlng!) <= r
  }
  // Inside the outer ring and in none of its holes
  return (ringsOf(g) ?? []).some((poly) => poly[0] && pointInPolygon(lat, lng, poly[0]) && !poly.slice(1).some((hole) => pointInPolygon(lat, lng, hole)))
}

/** The first place holding the point, or null. */
export function placeAt(lat: number, lng: number, places: readonly Place[]): Place | null {
  for (const pl of places) if (inBox(lat, lng, pl.box) && contains(lat, lng, pl.feature)) return pl
  return null
}

/** Metres from a point to a segment, on a local flat projection. */
function toSegment(lat: number, lng: number, a: [number, number], b: [number, number]): number {
  const k = 111_320
  const c = Math.cos((lat * Math.PI) / 180)
  const ax = (a[0] - lng) * k * c; const ay = (a[1] - lat) * k
  const bx = (b[0] - lng) * k * c; const by = (b[1] - lat) * k
  const dx = bx - ax; const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0
  return Math.hypot(ax + t * dx, ay + t * dy)
}

function metresTo(lat: number, lng: number, f: PlaceFeature): number {
  if (contains(lat, lng, f)) return 0
  const g = f.geometry
  if (g?.type === 'Point') {
    const [zlng, zlat] = g.coordinates as number[]
    return Math.max(0, haversineM(lat, lng, zlat!, zlng!) - (Number(f.properties?.radiusM) || 0))
  }
  let best = Infinity
  for (const poly of ringsOf(g) ?? []) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) best = Math.min(best, toSegment(lat, lng, ring[i - 1]!, ring[i]!))
  }
  return best
}

function metresToBox(lat: number, lng: number, b: Box): number {
  const k = 111_320
  const clat = Math.min(Math.max(lat, b.minLat), b.maxLat)
  const clng = Math.min(Math.max(lng, b.minLng), b.maxLng)
  return Math.hypot((lat - clat) * k, (lng - clng) * k * Math.cos((lat * Math.PI) / 180))
}

export interface Nearest { name: string; category: string; metres: number }

/** The authorised place nearest a stop: boxes pick a shortlist, only those are measured. */
export function nearestPlace(lat: number, lng: number, places: readonly Place[], shortlist = 24): Nearest | null {
  const near = places.map((pl) => ({ pl, d: metresToBox(lat, lng, pl.box) })).sort((a, b) => a.d - b.d).slice(0, shortlist)
  let best: Nearest | null = null
  for (const { pl } of near) {
    const metres = metresTo(lat, lng, pl.feature)
    if (Number.isFinite(metres) && (!best || metres < best.metres)) best = { name: pl.name, category: pl.category, metres: Math.round(metres) }
  }
  return best
}

/** A unit as the fleet snapshot has it (telemetry.repository findFleetSnapshot). */
export interface SnapshotUnit {
  vehicleId: string
  plate?: string | null
  name?: string | null
  lat: number | null
  lng: number | null
  speedKmh: number | null
  capturedAt: string | null
  movement?: { state: string; since: string } | null
}

export interface StopFlag {
  key: string
  vehicleId: string
  plate: string
  name: string | null
  kind: 'nogo' | 'unauthorised'
  zone: string | null
  since: number
  lat: number
  lng: number
}

const PLATE = /(?<![A-Za-z0-9])(K[A-Z]{2,3}) ?(\d{3}) ?([A-Z])(?![A-Z0-9])/
/** The registration inside a plate or name ("KCB 980V"), as new-ui lib/plate reads it. */
export function plateIn(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const m = typeof t === 'string' ? PLATE.exec(t) : null
    if (m) return `${m[1]} ${m[2]}${m[3]}`
  }
  return null
}

/** The units flagged now, most recent first. */
export function flaggedUnits(
  units: readonly SnapshotUnit[],
  { authorised = [], noGo = [], now = Date.now() }: { authorised?: readonly Place[]; noGo?: readonly Place[]; now?: number } = {},
): StopFlag[] {
  const allowed = [...storePlaces(), ...authorised]
  const out: StopFlag[] = []
  for (const v of units) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue
    const lat = v.lat as number
    const lng = v.lng as number
    const seen = v.capturedAt ? Date.parse(v.capturedAt) : NaN
    if (Number.isFinite(seen) && now - seen > STALE_MS) continue
    if (v.movement?.state === 'moving' || Math.round(v.speedKmh ?? 0) >= STAND_KMH) continue
    const since = Date.parse(v.movement?.since ?? '')
    if (!Number.isFinite(since)) continue
    const standing = now - since
    const base = { vehicleId: v.vehicleId, plate: plateIn(v.plate, v.name) ?? v.plate ?? v.vehicleId, name: v.name ?? null, since, lat, lng }
    const bad = placeAt(lat, lng, noGo)
    if (bad) {
      if (standing >= NOGO_MIN_MS) out.push({ ...base, key: `${v.vehicleId}|nogo|${bad.name}|${since}`, kind: 'nogo', zone: bad.name })
      continue
    }
    if (standing >= UNAUTHORISED_MIN_MS && !placeAt(lat, lng, allowed)) {
      out.push({ ...base, key: `${v.vehicleId}|stop|${since}`, kind: 'unauthorised', zone: null })
    }
  }
  return out.sort((a, b) => b.since - a.since)
}

/** "2 h 05 min", "12 min". */
export function standingWords(since: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - since) / 60_000))
  const h = Math.floor(min / 60)
  return h ? `${h} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`
}

/** What the toast says. */
export function flagWords(f: StopFlag, now = Date.now()): string {
  return f.kind === 'nogo'
    ? `${f.plate} has stood ${standingWords(f.since, now)} in the no-go zone ${f.zone}.`
    : `${f.plate} has stood ${standingWords(f.since, now)} outside any authorised place.`
}
