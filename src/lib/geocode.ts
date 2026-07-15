// Reverse geocoding for the dashboard's human location labels — resolves a
// lat/lng to the nearest named place (village/town + county) via the public
// OSM Nominatim service, with the same economics as lib/road-routes: every
// result is cached in memory AND on disk (.geocode-cache.json) keyed by a
// ~1.1 km grid cell, so a fleet that drives a fixed route universe converges
// to zero external requests. Nominatim usage policy compliance: one request
// at a time, ≥1.1 s apart, custom User-Agent, and a breaker that backs off
// after a failure.

import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger.js'

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse'
const CACHE_FILE     = path.resolve(process.cwd(), '.geocode-cache.json')
const FETCH_GAP_MS   = 1_100     // Nominatim policy: max 1 req/s
const BREAKER_MS     = 60_000    // back off this long after a fetch failure

const memory = new Map<string, string>()
let breakerUntil = 0
let queue: Promise<void> = Promise.resolve()   // serialises external fetches

// ~1.1 km grid — a place label doesn't change meaningfully within a cell, and
// coarse keys are what make the cache converge for vehicles moving on roads.
const keyOf = (lat: number, lng: number) => `${lat.toFixed(2)},${lng.toFixed(2)}`

// ── disk cache ──────────────────────────────────────────────────────────────

try {
  const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Record<string, string>
  for (const [k, v] of Object.entries(raw)) memory.set(k, v)
  logger.info({ places: memory.size }, 'geocode cache loaded from disk')
} catch { /* first boot — no cache yet */ }

let saveTimer: NodeJS.Timeout | null = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const obj = Object.fromEntries(memory)
    fs.writeFile(CACHE_FILE, JSON.stringify(obj), (err) => {
      if (err) logger.warn({ err }, 'geocode cache save failed')
    })
  }, 5_000)
}

// ── label composition ───────────────────────────────────────────────────────

interface NominatimAddress {
  village?: string; hamlet?: string; town?: string; suburb?: string
  city_district?: string; city?: string; municipality?: string
  county?: string; state?: string
}

/** "Kapsoit, Kericho County" — the most local name plus its county/state. */
function composeLabel(addr: NominatimAddress): string | null {
  const local =
    addr.village ?? addr.hamlet ?? addr.town ?? addr.suburb ??
    addr.city_district ?? addr.city ?? addr.municipality ?? null
  const region = addr.county ?? addr.state ?? null
  if (local && region && local !== region) return `${local}, ${region}`
  return local ?? region
}

// ── public API ──────────────────────────────────────────────────────────────

/** Nearest named place for a coordinate, or null when unresolvable. */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const key = keyOf(lat, lng)
  const hit = memory.get(key)
  if (hit !== undefined) return hit || null   // '' caches a "no name here" answer

  if (Date.now() < breakerUntil) return null

  // Serialise + pace all external lookups; concurrent callers for the same
  // cell resolve off the cache once the first fetch lands.
  const result = queue.then(async () => {
    const again = memory.get(key)
    if (again !== undefined) return again || null
    try {
      const url = `${NOMINATIM_BASE}?lat=${lat}&lon=${lng}&format=jsonv2&zoom=14&addressdetails=1`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'fleet-server/1.0 (dashboard location labels)' },
      })
      if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`)
      const body = await res.json() as { address?: NominatimAddress }
      const label = body.address ? composeLabel(body.address) : null
      memory.set(key, label ?? '')
      scheduleSave()
      return label
    } catch (err) {
      breakerUntil = Date.now() + BREAKER_MS
      logger.warn({ err, lat, lng }, 'reverse geocode failed — breaker engaged')
      return null
    }
  })
  // Keep the chain alive for pacing regardless of this lookup's outcome.
  queue = result.then(
    () => new Promise<void>(r => setTimeout(r, FETCH_GAP_MS)),
    () => new Promise<void>(r => setTimeout(r, FETCH_GAP_MS)),
  )
  return result
}
