// Real road-path routing for the simulated fleet.
//
// Vehicles used to move on straight origin→destination lines — cutting across
// farmland, forests and lakes on the map. This module resolves each leg to an
// actual road polyline via the public OSRM router (OpenStreetMap data) and
// caches every resolved path in memory AND on disk (.road-route-cache.json),
// so each unique origin→destination pair costs exactly ONE external request
// ever. The fleet's location universe is small and static (mill, parking,
// farms, depots, org HQs, customers, garages), so the cache converges within
// minutes of warm-up and the sim then runs fully offline.
//
// Lookups are synchronous (the simulator ticks synchronously): a cache miss
// returns null — the caller falls back to the straight line — and kicks off a
// background fetch so the NEXT tick follows the road. A short-circuit breaker
// stops hammering OSRM if it's unreachable.

import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger.js'

export interface RoadPath {
  /** [lat, lng] vertices along the road. */
  coords: [number, number][]
  /** Cumulative km at each vertex (same length as coords). */
  cumKm: number[]
  /** Total road distance in km. */
  totalKm: number
}

const OSRM_BASE   = 'https://router.project-osrm.org/route/v1/driving'
// Runtime file (gitignored) and the committed warm start — see lib/geocode for
// why the two are separate. This one matters more on disk: the seed is 351 KB
// and it was being rewritten in place, so every deploy tripped over it.
const CACHE_FILE  = path.resolve(process.cwd(), '.cache', 'road-routes.json')
const SEED_FILE   = path.resolve(process.cwd(), '.road-route-cache.json')
const FETCH_GAP_MS = 350          // be polite to the public demo server
const BREAKER_MS   = 60_000       // back off this long after a fetch failure

const memory   = new Map<string, RoadPath>()
const inflight = new Set<string>()
let breakerUntil = 0
let queue: Promise<void> = Promise.resolve()   // serialises external fetches

const keyOf = (aLat: number, aLng: number, bLat: number, bLng: number) =>
  `${aLat.toFixed(4)},${aLng.toFixed(4)}>${bLat.toFixed(4)},${bLng.toFixed(4)}`

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (bLat - aLat) * Math.PI / 180
  const dLng = (bLng - aLng) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

// ── disk cache ──────────────────────────────────────────────────────────────

for (const [file, kind] of [[CACHE_FILE, 'runtime'], [SEED_FILE, 'seed']] as const) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, RoadPath>
    for (const [k, v] of Object.entries(raw)) memory.set(k, v)
    logger.info({ routes: memory.size, kind }, 'road-route cache loaded from disk')
    break
  } catch { /* try the next one; neither existing is a normal first boot */ }
}

let saveTimer: NodeJS.Timeout | null = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(memory)))
    } catch (err) {
      logger.warn({ err }, 'road-route cache save failed')
    }
  }, 2_000)
}

// ── fetching ────────────────────────────────────────────────────────────────

async function fetchFromOsrm(aLat: number, aLng: number, bLat: number, bLng: number): Promise<RoadPath | null> {
  const url = `${OSRM_BASE}/${aLng},${aLat};${bLng},${bLat}?overview=simplified&geometries=geojson`
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`)
  const body = await res.json() as { code: string; routes?: { geometry: { coordinates: [number, number][] } }[] }
  if (body.code !== 'Ok' || !body.routes?.[0]) return null
  const coords: [number, number][] = body.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng])
  if (coords.length < 2) return null
  const cumKm: number[] = [0]
  for (let i = 1; i < coords.length; i++) {
    cumKm.push(cumKm[i - 1]! + haversineKm(coords[i - 1]![0], coords[i - 1]![1], coords[i]![0], coords[i]![1]))
  }
  return { coords, cumKm, totalKm: cumKm[cumKm.length - 1]! }
}

function fetchInBackground(key: string, aLat: number, aLng: number, bLat: number, bLng: number): void {
  if (inflight.has(key) || Date.now() < breakerUntil) return
  inflight.add(key)
  queue = queue.then(async () => {
    try {
      const path = await fetchFromOsrm(aLat, aLng, bLat, bLng)
      if (path) { memory.set(key, path); scheduleSave() }
      await new Promise(r => setTimeout(r, FETCH_GAP_MS))
    } catch (err) {
      breakerUntil = Date.now() + BREAKER_MS
      logger.warn({ err, key }, 'road-route fetch failed — straight-line fallback for now')
    } finally {
      inflight.delete(key)
    }
  })
}

// ── public API ──────────────────────────────────────────────────────────────

/** Synchronous cache lookup. A miss returns null (caller falls back to the
 *  straight line) and schedules a background fetch for subsequent ticks. */
export function getRoadPath(aLat: number, aLng: number, bLat: number, bLng: number): RoadPath | null {
  const key = keyOf(aLat, aLng, bLat, bLng)
  const hit = memory.get(key)
  if (hit) return hit
  fetchInBackground(key, aLat, aLng, bLat, bLng)
  return null
}

/** Awaitable variant for request handlers (route-line endpoint): resolves the
 *  path now, fetching if needed. */
export async function getRoadPathAsync(aLat: number, aLng: number, bLat: number, bLng: number): Promise<RoadPath | null> {
  const key = keyOf(aLat, aLng, bLat, bLng)
  const hit = memory.get(key)
  if (hit) return hit
  if (Date.now() < breakerUntil) return null
  try {
    const path = await fetchFromOsrm(aLat, aLng, bLat, bLng)
    if (path) { memory.set(key, path); scheduleSave() }
    return path
  } catch (err) {
    breakerUntil = Date.now() + BREAKER_MS
    logger.warn({ err, key }, 'road-route fetch failed')
    return null
  }
}

/** Position + heading at `km` along the path (clamped to the ends). */
export function pointAlongPath(p: RoadPath, km: number): { lat: number; lng: number; headingDeg: number } {
  const target = Math.max(0, Math.min(km, p.totalKm))
  // binary search for the segment containing `target`
  let lo = 0, hi = p.cumKm.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (p.cumKm[mid]! <= target) lo = mid
    else hi = mid
  }
  const segLen = p.cumKm[hi]! - p.cumKm[lo]!
  const t = segLen > 0 ? (target - p.cumKm[lo]!) / segLen : 0
  const [aLat, aLng] = p.coords[lo]!
  const [bLat, bLng] = p.coords[hi]!
  const lat = aLat + (bLat - aLat) * t
  const lng = aLng + (bLng - aLng) * t
  const heading = (Math.atan2(
    Math.sin((bLng - aLng) * Math.PI / 180) * Math.cos(bLat * Math.PI / 180),
    Math.cos(aLat * Math.PI / 180) * Math.sin(bLat * Math.PI / 180) -
    Math.sin(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.cos((bLng - aLng) * Math.PI / 180),
  ) * 180 / Math.PI + 360) % 360
  return { lat, lng, headingDeg: heading }
}

/** Pre-resolve a list of [aLat, aLng, bLat, bLng] pairs (both directions are
 *  distinct routes — one-way streets). Sequential and polite; cache hits are
 *  skipped, so re-runs cost nothing. */
export async function warmRoadRoutes(pairs: [number, number, number, number][]): Promise<void> {
  let fetched = 0
  for (const [aLat, aLng, bLat, bLng] of pairs) {
    if (memory.has(keyOf(aLat, aLng, bLat, bLng))) continue
    const p = await getRoadPathAsync(aLat, aLng, bLat, bLng)
    if (p) fetched++
    await new Promise(r => setTimeout(r, FETCH_GAP_MS))
  }
  if (fetched > 0) logger.info({ fetched, cached: memory.size }, 'road routes warmed')
}
