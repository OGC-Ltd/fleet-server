/**
 * Place names for a review's places — OpenStreetMap reverse geocoding.
 *
 * Nominatim's public service asks for at most one request a second, an
 * identifying User-Agent, and caching; all three are kept here. Every lookup in
 * the process goes through ONE queue spaced 1.1 s apart, whichever review asked,
 * and an answer is kept for the life of the process at ~100 m (3 decimals), so a
 * second review of the same unit, or of another unit at the same depot, names
 * its places without asking again.
 */

import { logger } from '../../lib/logger.js'
import { haversineM, type ReviewPlace } from './usage-review.compute.js'

const URL_BASE = 'https://nominatim.openstreetmap.org/reverse'
const USER_AGENT = 'fleettrack-usage-review/1.0 (logistics.raioperations.com)'
const SPACING_MS = 1_100
const TIMEOUT_MS = 15_000
const CACHE_MAX = 20_000

export interface PlaceName {
  name: string
  area: string | null
  county: string | null
  country: string | null
  address: string | null
}

type Address = Record<string, string | undefined>

const cache = new Map<string, PlaceName | null>()
let queue: Promise<unknown> = Promise.resolve()
let lastCall = 0

const key = (lat: number, lng: number) => `${lat.toFixed(3)},${lng.toFixed(3)}`
const unward = (s: string | undefined) => s?.replace(/\s+ward$/i, '').trim() || undefined
/** Title Case: OpenStreetMap spells many names in lower case ("riat centre"). Only first letters are raised. */
export const titleCase = (s: string) => s.replace(/(^|[\s,/–-])(\p{Ll})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())

/**
 * A short, readable name out of an OSM address — "Bukembe East, Kanduyi",
 * "Webuye town", "Mtangani, Malindi Town". In Kenya OSM files the ward under
 * `city` (with " ward"), the constituency under `county`, and the county under
 * `state`.
 */
export function nameFromAddress(a: Address): Omit<PlaceName, 'address'> {
  const town = a['town'] ?? (a['city'] && !/ward$/i.test(a['city']) ? a['city'] : undefined)
  const ward = unward(a['city'] && /ward$/i.test(a['city']) ? a['city'] : a['city_district'])
  const local = a['suburb'] ?? a['village'] ?? a['hamlet'] ?? a['neighbourhood'] ?? a['quarter']
  const constituency = a['county'] ?? a['state_district'] ?? a['municipality']
  let name: string
  if (local) name = [local, ward ?? town ?? constituency].filter(Boolean).join(', ')
  else if (town) name = `${town} town`
  else if (ward) name = [ward, constituency].filter(Boolean).join(', ')
  else name = a['road'] ?? constituency ?? a['state'] ?? a['country'] ?? ''
  return {
    name: titleCase(name || 'Unnamed place'),
    area: [ward, town, constituency].filter((x, i, xs) => x && xs.indexOf(x) === i).join(', ') || null,
    county: a['state'] ?? null,
    country: a['country'] ?? null,
  }
}

async function lookupNow(lat: number, lng: number): Promise<PlaceName | null> {
  const wait = lastCall + SPACING_MS - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastCall = Date.now()
  const q = new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lng), zoom: '16', 'accept-language': 'en' })
  const res = await fetch(`${URL_BASE}?${q}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`)
  const body = await res.json() as { address?: Address; display_name?: string }
  if (!body.address) return null
  return { ...nameFromAddress(body.address), address: body.display_name ?? null }
}

/** One lookup, through the shared queue and the cache. Never throws. */
export function reverseGeocode(lat: number, lng: number): Promise<PlaceName | null> {
  const k = key(lat, lng)
  if (cache.has(k)) return Promise.resolve(cache.get(k) ?? null)
  const job = queue.then(async () => {
    if (cache.has(k)) return cache.get(k) ?? null
    try {
      const got = await lookupNow(lat, lng)
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
      cache.set(k, got)
      return got
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Usage review: reverse geocode failed')
      return null           // not cached: the next review tries again
    }
  })
  queue = job.catch(() => undefined)
  return job
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
function compass(from: ReviewPlace, to: ReviewPlace): string {
  const r = Math.PI / 180
  const y = Math.sin((to.lng - from.lng) * r) * Math.cos(to.lat * r)
  const x = Math.cos(from.lat * r) * Math.sin(to.lat * r) - Math.sin(from.lat * r) * Math.cos(to.lat * r) * Math.cos((to.lng - from.lng) * r)
  const deg = (Math.atan2(y, x) / r + 360) % 360
  return COMPASS[Math.round(deg / 45) % 8]!
}

/**
 * Name the first `limit` places (they are ranked by time spent), in place.
 * Two places that come back with the same name are told apart by direction
 * from the higher-ranked one: "Bukembe East, Kanduyi (north, 3.1 km)".
 */
export async function namePlaces(places: ReviewPlace[], limit: number, onProgress: (done: number, total: number) => void) {
  const todo = places.slice(0, limit)
  let done = 0
  onProgress(0, todo.length)
  for (const p of todo) {
    const got = await reverseGeocode(p.lat, p.lng)
    if (got) Object.assign(p, got)
    onProgress(++done, todo.length)
  }
  const firstByName = new Map<string, ReviewPlace>()
  for (const p of todo) {
    if (!p.name) continue
    const first = firstByName.get(p.name)
    if (!first) { firstByName.set(p.name, p); continue }
    const km = haversineM(first.lat, first.lng, p.lat, p.lng) / 1000
    p.name = `${p.name} (${compass(first, p)}, ${km.toFixed(1)} km)`
  }
}
