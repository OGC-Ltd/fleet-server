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
// Where the RUNNING process writes. Gitignored, because this file is rewritten
// every few seconds: tracked, it left the working tree permanently dirty and
// every `git push` into the box's tree was rejected until someone ran
// `git checkout -- .` — a step whose other job is discarding real work.
const CACHE_FILE     = path.resolve(process.cwd(), '.cache', 'geocode.json')
// The committed WARM START, read only when the runtime file does not exist yet.
// Worth keeping in the repo: Nominatim's usage policy caps us at roughly one
// request per 1.1 s, so a genuinely cold box would spend many minutes labelling
// places it already had answers for.
const SEED_FILE      = path.resolve(process.cwd(), '.geocode-cache.json')
const FETCH_GAP_MS   = 1_100     // Nominatim policy: max 1 req/s
const BREAKER_MS     = 60_000    // back off this long after a fetch failure

const memory = new Map<string, string>()
let breakerUntil = 0
let queue: Promise<void> = Promise.resolve()   // serialises external fetches

// ~1.1 km grid — a place label doesn't change meaningfully within a cell, and
// coarse keys are what make the cache converge for vehicles moving on roads.
// The `v2:` prefix invalidates labels cached by the previous composeLabel,
// which produced single-word answers. Bump it whenever the label FORMAT
// changes, or the disk cache will keep serving the old shape indefinitely.
const keyOf = (lat: number, lng: number) => `v2:${lat.toFixed(2)},${lng.toFixed(2)}`

// ── disk cache ──────────────────────────────────────────────────────────────

// Runtime file first, committed seed second — never both, so a stale seed can
// never resurrect labels the running cache has already superseded.
for (const [file, kind] of [[CACHE_FILE, 'runtime'], [SEED_FILE, 'seed']] as const) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) memory.set(k, v)
    logger.info({ places: memory.size, kind }, 'geocode cache loaded from disk')
    break
  } catch { /* try the next one; neither existing is a normal first boot */ }
}

let saveTimer: NodeJS.Timeout | null = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const obj = Object.fromEntries(memory)
    // mkdir on every save rather than at import: it is one syscall every five
    // seconds at most, and it means a deleted .cache/ heals itself instead of
    // silently dropping every label learned after the deletion.
    fs.mkdir(path.dirname(CACHE_FILE), { recursive: true }, (mkErr) => {
      if (mkErr) { logger.warn({ err: mkErr }, 'geocode cache dir failed'); return }
      fs.writeFile(CACHE_FILE, JSON.stringify(obj), (err) => {
        if (err) logger.warn({ err }, 'geocode cache save failed')
      })
    })
  }, 5_000)
}

// ── label composition ───────────────────────────────────────────────────────

interface NominatimAddress {
  road?: string; neighbourhood?: string
  village?: string; hamlet?: string; town?: string; suburb?: string
  city_district?: string; city?: string; municipality?: string
  county?: string; state?: string; country?: string
}

/**
 * "Kapsoit, Kericho County, Kenya" — a place label with enough parts to be
 * unambiguous on its own.
 *
 * The previous version emitted `local ?? region`, which collapsed to a SINGLE
 * word whenever the two matched — Kigoma town sits in Kigoma Region, so a
 * vehicle there was labelled just "Kigoma", which reads like missing data
 * rather than a location. This walks three tiers (local → region → country),
 * takes the first available value in each, and de-duplicates, so the label is
 * as complete as the data allows and never repeats a name.
 */
function composeLabel(addr: NominatimAddress): string | null {
  const local =
    addr.neighbourhood ?? addr.village ?? addr.hamlet ?? addr.town ??
    addr.suburb ?? addr.city_district ?? addr.city ?? addr.municipality ?? null
  const region  = addr.county ?? addr.state ?? null
  const country = addr.country ?? null

  // `road` only earns a place when it adds detail the locality does not — it
  // is the difference between "Kigoma" and "Ujiji Road, Kigoma".
  const street = addr.road && addr.road !== local ? addr.road : null

  const parts: string[] = []
  for (const part of [street, local, region, country]) {
    if (!part) continue
    // Case-insensitive de-dupe: "Kigoma" the town inside "Kigoma" the region
    // must contribute one part, not two.
    if (parts.some(p => p.toLowerCase() === part.toLowerCase())) continue
    parts.push(part)
  }

  if (parts.length === 0) return null
  // Three parts is the readable ceiling for a tooltip line.
  return parts.slice(0, 3).join(', ')
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * The label for this cell IF it is already cached — never queues a fetch.
 *
 * For read paths that must answer now. `reverseGeocode` is correct but it is
 * serialised at one request per 1.1s by Nominatim's usage policy, so awaiting
 * it for a page of fifty rows is a minute of latency on a cache-cold fleet.
 * This returns what is already known and null otherwise, leaving the caller to
 * warm the cell in the background if it wants the next read to have it.
 */
export function cachedPlace(lat: number, lng: number): string | null {
  return memory.get(keyOf(lat, lng)) ?? null
}

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
      const url = `${NOMINATIM_BASE}?lat=${lat}&lon=${lng}&format=jsonv2&zoom=16&addressdetails=1`
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
