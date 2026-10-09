/**
 * The business or building at each place, from OpenStreetMap (operator,
 * 2026-10-09: "exact location is null and activity is null" — the page's
 * Google lookups had run out of quota, and the server has no Google key).
 *
 * One Overpass query for all the review's places: the named businesses and
 * buildings within RADIUS_M of each, and the named premises each stands
 * inside (a factory's grounds, a hospital's, a school's). A place takes the
 * nearest named business within RADIUS_M; failing that, the smallest named
 * premises around it. Its activity — Banking, Food and drink, Medical — comes
 * from the OSM tags, in the same groups the page uses for Google's types
 * (new-ui lib/placeActivity).
 *
 * Google's name, when the page has one, still wins on a download
 * (usage-review.routes withNames). Never throws: a failed query names nothing.
 */

import { logger } from '../../lib/logger.js'
import { haversineM, type ReviewPlace } from './usage-review.compute.js'
import { titleCase } from './usage-review.geocode.js'
import { persistentStore } from './usage-review.store.js'

/** The public Overpass servers: the main one, then a mirror. Each hands an IP
 *  a couple of query slots and answers 429 while they are busy. */
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
/** Waits before each round over the servers after the first. */
const BACKOFF_MS = [8_000, 20_000]
const USER_AGENT = 'fleettrack-usage-review/1.0 (logistics.raioperations.com)'
const RADIUS_M = 150
const TIMEOUT_MS = 45_000
/** The whole lookup's budget: past it, the places left keep their area name
 *  rather than hold the review up. */
const BUDGET_MS = 75_000
/** Places per query: the premises lookups are the slow part (~2 s a place). */
const BATCH = 10
const CACHE_MAX = 20_000

/** The tag keys that make a named thing a business or a building's use. */
const KEYS = ['amenity', 'shop', 'office', 'craft', 'healthcare', 'tourism', 'industrial', 'man_made', 'leisure']
const LANDUSE = /^(industrial|commercial|retail|military|farmyard|railway)$/

export interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number }
  tags?: Record<string, string>
}
export interface Poi { name: string; activity: string | null }

const has = (t: Record<string, string>, k: string, re: RegExp) => t[k] != null && re.test(t[k]!)

/** What an OSM feature is, in the page's groups. Null when its tags do not say. */
export function osmActivity(t: Record<string, string>): string | null {
  if (has(t, 'amenity', /^(fuel|charging_station)$/)) return 'Fuel'
  if (has(t, 'shop', /^(car_repair|car|car_parts|tyres|motorcycle)$/) || has(t, 'amenity', /^(car_wash|vehicle_inspection)$/) || has(t, 'craft', /^(car_repair|mechanic)$/)) return 'Mechanical'
  if (has(t, 'amenity', /^(bank|atm|bureau_de_change|money_transfer|microfinance)$/) || has(t, 'office', /^(financial|insurance|accountant)$/)) return 'Banking'
  if (has(t, 'amenity', /^(hospital|clinic|doctors|dentist|pharmacy|health_post|veterinary)$/) || t['healthcare'] || has(t, 'shop', /^(chemist|medical_supply)$/)) return 'Medical'
  if (has(t, 'shop', /^(hairdresser|beauty|barber|massage)$/) || has(t, 'amenity', /^spa$/)) return 'Barber / salon'
  if (has(t, 'amenity', /^(nightclub|casino|cinema|theatre)$/) || has(t, 'tourism', /^resort$/) || has(t, 'leisure', /^(resort|stadium|park|sports_centre|pitch|fitness_centre|water_park)$/)) return 'Entertainment'
  if (has(t, 'tourism', /^(hotel|motel|guest_house|hostel|camp_site|apartment)$/)) return 'Lodging'
  if (has(t, 'amenity', /^(restaurant|cafe|fast_food|bar|pub|food_court|biergarten)$/) || has(t, 'shop', /^(bakery|butcher)$/)) return 'Food and drink'
  if (has(t, 'amenity', /^place_of_worship$/)) return 'Worship'
  if (has(t, 'amenity', /^(school|college|university|kindergarten|library|training)$/)) return 'Education'
  if (has(t, 'amenity', /^(police|townhall|courthouse|post_office|fire_station|prison)$/) || has(t, 'office', /^government$/)) return 'Government'
  if (t['shop'] || has(t, 'amenity', /^marketplace$/) || has(t, 'landuse', /^(retail|commercial)$/)) return 'Shopping'
  if (has(t, 'amenity', /^(bus_station|parking|taxi|ferry_terminal)$/) || has(t, 'landuse', /^railway$/)) return 'Transport'
  if (t['industrial'] || t['craft'] || has(t, 'landuse', /^industrial$/) || has(t, 'man_made', /^(works|silo|storage_tank|water_works|wastewater_plant)$/)) return 'Work'
  if (has(t, 'landuse', /^farmyard$/) || has(t, 'place', /^farm$/)) return 'Farm'
  if (t['office']) return 'Offices'
  return null
}

const isBusiness = (t: Record<string, string>) => KEYS.some(k => t[k] != null) || has(t, 'landuse', LANDUSE)
const at = (e: OsmElement) => (e.lat != null && e.lon != null ? { lat: e.lat, lon: e.lon } : e.center ?? null)
const inside = (e: OsmElement, lat: number, lng: number) =>
  !!e.bounds && lat >= e.bounds.minlat && lat <= e.bounds.maxlat && lng >= e.bounds.minlon && lng <= e.bounds.maxlon
const boxArea = (e: OsmElement) => (e.bounds ? (e.bounds.maxlat - e.bounds.minlat) * (e.bounds.maxlon - e.bounds.minlon) : Infinity)

/**
 * The business at `lat, lng` among `els`: the nearest named one within
 * RADIUS_M (a point, or a small building), else the smallest named premises
 * whose outline box holds the spot.
 */
export function pickPoi(lat: number, lng: number, els: OsmElement[]): Poi | null {
  const named = els.filter(e => e.tags?.['name'] && isBusiness(e.tags))
  let best: { e: OsmElement; m: number } | null = null
  for (const e of named) {
    const p = at(e)
    if (!p) continue
    const m = haversineM(lat, lng, p.lat, p.lon)
    if (m <= RADIUS_M && (!best || m < best.m)) best = { e, m }
  }
  const pick = best?.e ?? named.filter(e => e.type !== 'node' && inside(e, lat, lng)).sort((a, b) => boxArea(a) - boxArea(b))[0]
  if (!pick) return null
  const raw = pick.tags!['name']!.trim()
  // "WEST KENYA SUGAR COMPANY" → "West Kenya Sugar Company"
  const name = raw === raw.toUpperCase() && /[A-Z]{3}/.test(raw) ? titleCase(raw.toLowerCase()) : raw
  return { name, activity: osmActivity(pick.tags!) }
}

// Kept on disk (usage-review.store): businesses for three months, "none"
// for a fortnight.
const cache = persistentStore<Poi | null>('poi', { hitTtlMs: 90 * 86_400_000, missTtlMs: 14 * 86_400_000, max: CACHE_MAX })
const key = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`

function query(pts: { lat: number; lng: number }[]): string {
  const f = (lat: number, lng: number) => `(around:${RADIUS_M},${lat.toFixed(6)},${lng.toFixed(6)})`
  const near = pts.map(p => KEYS.map(k => `nwr${f(p.lat, p.lng)}[name][${k}];`).join('') + `wr${f(p.lat, p.lng)}[name][landuse];`).join('\n')
  const within = pts.map((p, i) => `is_in(${p.lat.toFixed(6)},${p.lng.toFixed(6)})->.a${i};`).join('\n')
  const areas = pts.map((_, i) => `area.a${i}[name];`).join('')
  return `[out:json][timeout:50];\n${within}\n(${areas})->.in;\n(\n${near}\nway(pivot.in);rel(pivot.in);\n);\nout tags center bb;`
}

/** One query, server by server, backing off while they are busy. */
async function overpass(data: string, deadline: number): Promise<OsmElement[]> {
  let last = 'no server answered'
  for (const wait of [0, ...BACKOFF_MS]) {
    if (Date.now() + wait + 5_000 > deadline) break
    if (wait) await new Promise(r => setTimeout(r, wait))
    for (const url of SERVERS) {
      const left = deadline - Date.now()
      if (left < 5_000) break
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data }),
          signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left)),
        })
        if (res.ok) return ((await res.json()) as { elements: OsmElement[] }).elements
        last = `Overpass HTTP ${res.status} (${new globalThis.URL(url).host})`
        if (res.status !== 429 && res.status < 500) throw new Error(last)
      } catch (err) {
        last = (err as Error).message
      }
    }
  }
  throw new Error(last)
}

/**
 * Name the first `limit` places from OpenStreetMap, in place: `exactName` and
 * `activity`, where a named business or premises is found.
 */
export async function namePois(places: ReviewPlace[], limit: number, budgetMs = BUDGET_MS): Promise<void> {
  const deadline = Date.now() + budgetMs
  const todo = places.slice(0, limit)
  const all = todo.filter(p => !cache.has(key(p.lat, p.lng)))
  const batches: ReviewPlace[][] = []
  for (let i = 0; i < all.length; i += BATCH) batches.push(all.slice(i, i + BATCH))
  // Two batches at a time — Overpass gives each address two slots — so three
  // batches take the time of two, not three.
  const worker = async () => {
    for (let ask = batches.shift(); ask; ask = batches.shift()) {
      try {
        if (Date.now() > deadline - 5_000) return
        const elements = await overpass(query(ask), deadline)
        for (const p of ask) cache.set(key(p.lat, p.lng), pickPoi(p.lat, p.lng, elements))
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Usage review: OpenStreetMap businesses not read')
      }
    }
  }
  await Promise.all([worker(), worker()])
  for (const p of todo) {
    const k = key(p.lat, p.lng)
    // Looked up, whether or not a business was found: the page does not ask
    // OpenStreetMap again for it (it did, and it cost 15 s a batch).
    if (cache.has(k)) p.poiTried = true
    const got = cache.get(k)
    if (got) { p.exactName = got.name; p.activity = got.activity }
  }
}
