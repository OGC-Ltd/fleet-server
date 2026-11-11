/**
 * A written address to a point, for itinerary stops Wialon exported without
 * coordinates ("C35, Londiani, Kenya", "50300 Kakamega Rd, Mukumu, Kenya").
 *
 * Google Geocoding first, with the server's Google key (the same one the
 * Routes, Roads and Weather calls use), held to Kenya: Wialon's own addresses
 * come from Google, so they round-trip. Its `location_type` says how close it
 * is: ROOFTOP / RANGE_INTERPOLATED is the door, GEOMETRIC_CENTER /
 * APPROXIMATE is the middle of a road or an area, which the preview flags so
 * a person checks the fence. OpenStreetMap's search (one call a second, its
 * usage policy) when Google is not configured or finds nothing; its answers
 * are always flagged.
 *
 * Answers are cached in memory for the process: a preview and its save ask
 * the same addresses minutes apart.
 */
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'

export interface AddressPoint { lat: number, lng: number, exact: boolean, source: 'google' | 'osm' }

const TIMEOUT_MS = 8_000
const OSM_GAP_MS = 1_100
const cache = new Map<string, AddressPoint | null>()
let osmQueue: Promise<unknown> = Promise.resolve()

/** Kenya with room, as the sheet reader holds points to East Africa. */
const inKenya = (lat: number, lng: number) => lat >= -5 && lat <= 5.5 && lng >= 33.5 && lng <= 42.5

async function google(address: string): Promise<AddressPoint | null> {
  if (!env.GOOGLE_ROUTING_API_KEY) return null
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('region', 'ke')
  url.searchParams.set('components', 'country:KE')
  url.searchParams.set('key', env.GOOGLE_ROUTING_API_KEY)
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const j = await res.json().catch(() => ({})) as {
    status?: string, error_message?: string
    results?: Array<{ geometry?: { location?: { lat?: number, lng?: number }, location_type?: string } }>
  }
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') throw new Error(`Google geocode ${j.status}: ${j.error_message ?? ''}`)
  const g = j.results?.[0]?.geometry
  const lat = g?.location?.lat
  const lng = g?.location?.lng
  if (typeof lat !== 'number' || typeof lng !== 'number' || !inKenya(lat, lng)) return null
  return { lat, lng, exact: g?.location_type === 'ROOFTOP' || g?.location_type === 'RANGE_INTERPOLATED', source: 'google' }
}

function osm(address: string): Promise<AddressPoint | null> {
  const job = osmQueue.then(async () => {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', address)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('countrycodes', 'ke')
    url.searchParams.set('limit', '1')
    const res = await fetch(url, { headers: { 'User-Agent': 'fleet-server/1.0 (planner itinerary addresses)' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`)
    const [hit] = await res.json() as Array<{ lat?: string, lon?: string }>
    const lat = Number(hit?.lat)
    const lng = Number(hit?.lon)
    return Number.isFinite(lat) && Number.isFinite(lng) && inKenya(lat, lng)
      ? { lat, lng, exact: false, source: 'osm' as const } : null
  })
  osmQueue = job.catch(() => undefined).then(() => new Promise((r) => setTimeout(r, OSM_GAP_MS)))
  return job
}

/** The point for an address, or null. Never throws. */
export async function geocodeAddress(address: string): Promise<AddressPoint | null> {
  const k = address.trim().toUpperCase()
  if (!k) return null
  if (cache.has(k)) return cache.get(k)!
  let got: AddressPoint | null = null
  try { got = await google(address) } catch (err) { logger.warn({ err: (err as Error).message }, 'Planner: Google geocode failed') }
  if (!got) {
    try { got = await osm(address) } catch (err) { logger.warn({ err: (err as Error).message }, 'Planner: OSM search failed'); return null }
  }
  cache.set(k, got)
  return got
}
