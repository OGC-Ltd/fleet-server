/**
 * Places named by the company's own ground (operator, 2026-10-09): "if a unit
 * is within the geofence/site-plan, for instance Raiply, we know it's at work —
 * use the site plan, and if the site plan has other areas named within it, use
 * the specific area name. This will prevent the wrong name."
 *
 * The wrong name was the nearest business Google or OpenStreetMap could find:
 * a lorry parked inside Raiply's fence was logged under whatever shop stood
 * closest to the coordinate. The surveys say exactly where the company's sites
 * are, so for a place inside one they decide the name, and nothing looked up
 * afterwards overrides it.
 *
 *   1. a surveyed site — the fence a works-site survey draws ("Raiply"), and
 *      inside it the named area or pin the unit stood at ("Garage, Kabras");
 *      a pin counts within PIN_RADIUS_M, which also takes in a lorry waiting
 *      just outside a gate drawn on the fence line;
 *   2. a surveyed area with no fence round it (Menengai's Molo river reaches);
 *   3. the smallest of the organisation's own area geofences that holds it.
 *
 * Every one of those is work (usage-review.areas reads `nameFrom`).
 *
 * The surveys are COPIES of new-ui's public/*-site.geojson, which is where they
 * are drawn on the map (new-ui lib/sitePlans.js). A new survey goes in both
 * places. Read once, on first use.
 */

import fs from 'node:fs'
import path from 'node:path'
import { haversineM, isInsideFence, pointInPolygon } from '../../lib/geofence.js'
import { ringAreaHa } from '../../lib/zone-taxonomy.js'
import { logger } from '../../lib/logger.js'
import type { ReviewPlace, ReviewStop } from './usage-review.compute.js'
import type { Site } from './usage-review.areas.js'

/** A stop this close to a surveyed pin stood at it. Kabras' pins are 4–60 m
 *  apart, so the nearest pin within this wins; GPS puts a parked unit within
 *  about 10 m of where it is. */
export const PIN_RADIUS_M = 50
/** A geofence bigger than this is a region ("Selia Region"), not a place name.
 *  The same bound usage-review.areas puts on a work site. */
const MAX_NAMING_FENCE_HA = 2_000

type Ring = [number, number][]

export interface SitePlan {
  /** The fence's name ("Raiply"); null for a survey with no fence. */
  name: string | null
  perimeter: Ring | null
  ha: number
  areas: { name: string; ring: Ring; ha: number }[]
  pins: { name: string; lat: number; lng: number }[]
}

export interface Spot {
  /** The site: the survey's fence, a fenceless surveyed area, or a geofence. */
  site: string
  /** The named area or pin inside the site, when the unit stood at one. */
  area: string | null
  from: 'site-plan' | 'geofence'
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/**
 * A survey's name as it should read: entities decoded ("Transport &amp; PWH"
 * came through the KML export) and a name in capitals spoken rather than
 * shouted ("MOLO RIVER" → "Molo River"), as the map's hover card does.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.replace(/&(amp|lt|gt|quot|#39);/g, m => ENTITIES[m] ?? m).replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (/[A-Z]{2}/.test(s) && !/[a-z]/.test(s)) s = s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase())
  return s
}

/** One survey, from its GeoJSON. */
export function parseSitePlan(fc: unknown): SitePlan {
  const plan: SitePlan = { name: null, perimeter: null, ha: 0, areas: [], pins: [] }
  const features = (fc as { features?: unknown[] })?.features
  for (const f of Array.isArray(features) ? features : []) {
    const props = ((f as { properties?: Record<string, unknown> }).properties ?? {})
    const geom = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry
    const name = cleanName(props['name'])
    if (geom?.type === 'Polygon') {
      const ring = (geom.coordinates as Ring[] | undefined)?.[0]
      if (!Array.isArray(ring) || ring.length < 3) continue
      if (props['category'] === 'perimeter' && !plan.perimeter) {
        plan.perimeter = ring
        plan.ha = ringAreaHa(ring)
        plan.name = name
      } else if (name) {
        plan.areas.push({ name, ring, ha: ringAreaHa(ring) })
      }
    } else if (geom?.type === 'Point' && name) {
      const [lng, lat] = geom.coordinates as [number, number]
      if (Number.isFinite(lat) && Number.isFinite(lng)) plan.pins.push({ name, lat, lng })
    }
  }
  return plan
}

let cached: SitePlan[] | null = null

/** Every survey on the platform. A unit at another company's site is still at
 *  that site, so all of them are tested, whoever owns the unit. */
export function loadSitePlans(dir = path.resolve(process.cwd(), 'assets', 'site-plans')): SitePlan[] {
  if (cached) return cached
  const out: SitePlan[] = []
  try {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.geojson')).sort()) {
      try { out.push(parseSitePlan(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))) } catch (err) {
        logger.warn({ file, err: (err as Error).message }, 'Usage review: site plan not read')
      }
    }
  } catch (err) {
    logger.warn({ dir, err: (err as Error).message }, 'Usage review: no site plans to name places by')
  }
  cached = out
  return out
}

const fenceHa = (s: Site): number => {
  const f = s.fence
  if (!f) return Infinity
  if (f.type === 'CIRCLE') return (Math.PI * f.radiusM * f.radiusM) / 10_000
  if (f.type === 'POLYGON') return ringAreaHa(f.polygonCoords)
  return Infinity
}

/** Where a point stands, by the company's own ground — see the module note. */
export function spotAt(lat: number, lng: number, plans: SitePlan[], fences: Site[] = []): Spot | null {
  // 1. A surveyed site: inside its fence, or at one of its pins.
  let best: { plan: SitePlan; ha: number } | null = null
  for (const plan of plans) {
    if (!plan.perimeter || !plan.name || !pointInPolygon(lat, lng, plan.perimeter)) continue
    if (!best || plan.ha < best.ha) best = { plan, ha: plan.ha }
  }
  let pinHit: { plan: SitePlan; name: string; d: number } | null = null
  for (const plan of best ? [best.plan] : plans) {
    if (!plan.name) continue
    for (const pin of plan.pins) {
      const d = haversineM(lat, lng, pin.lat, pin.lng)
      if (d <= PIN_RADIUS_M && (!pinHit || d < pinHit.d)) pinHit = { plan, name: pin.name, d }
    }
  }
  if (best) {
    const area = best.plan.areas
      .filter(a => pointInPolygon(lat, lng, a.ring))
      .sort((a, b) => a.ha - b.ha)[0]?.name ?? pinHit?.name ?? null
    return { site: best.plan.name!, area, from: 'site-plan' }
  }
  if (pinHit) return { site: pinHit.plan.name!, area: pinHit.name, from: 'site-plan' }

  // 2. A surveyed area with no fence round it.
  const open = plans.filter(p => !p.perimeter).flatMap(p => p.areas)
    .filter(a => pointInPolygon(lat, lng, a.ring)).sort((a, b) => a.ha - b.ha)[0]
  if (open) return { site: open.name, area: null, from: 'site-plan' }

  // 3. The organisation's own geofences, smallest first.
  const fence = fences
    .filter(s => s.fence && fenceHa(s) <= MAX_NAMING_FENCE_HA && isInsideFence(lat, lng, s.fence))
    .sort((a, b) => fenceHa(a) - fenceHa(b))[0]
  return fence ? { site: fence.name, area: null, from: 'geofence' } : null
}

/**
 * "Garage, Kabras": the area first, because it is the more exact answer, and
 * the site after it for where that is. An area already carrying the site's own
 * name ("Nzoia Main Gate" at Nzoia Sugar) is not told it twice.
 */
export function spotName(s: Pick<Spot, 'site' | 'area'>): string {
  if (!s.area || s.area.toLowerCase() === s.site.toLowerCase()) return s.site
  const head = s.site.split(/\s+/)[0]!.toLowerCase()
  if (head.length >= 4 && new RegExp(`\\b${head.replace(/[^\p{L}\p{N}]/gu, '')}\\b`, 'iu').test(s.area)) return s.area
  return `${s.area}, ${s.site}`
}

/**
 * Name every place that stands on the company's own ground, in place.
 *
 * A place is a 400 m cluster of stops, so its centre can fall between two
 * pins, or across a fence line, from where the unit actually stood. Each STOP
 * is tested instead, and the place goes by where its time was spent: on the
 * site where at least half of it was, and within that site the named area —
 * or the site as a whole — that held the most.
 *
 * Sets `exactName`, `site`, `nameFrom` and the activity "Work". Nothing named
 * afterwards (OpenStreetMap on the build, Google from the page) replaces it.
 */
export function nameBySite(places: ReviewPlace[], stops: ReviewStop[], plans: SitePlan[], fences: Site[] = []): number {
  const byPlace = new Map<number, ReviewStop[]>()
  for (const s of stops) {
    const list = byPlace.get(s.place)
    if (list) list.push(s); else byPlace.set(s.place, [s])
  }
  let named = 0
  for (const p of places) {
    const mine = byPlace.get(p.id)
    const samples = mine?.length
      ? mine.map(s => ({ lat: s.lat, lng: s.lng, ms: Math.max(1, s.end - s.start) }))
      : [{ lat: p.lat, lng: p.lng, ms: 1 }]
    const total = samples.reduce((a, s) => a + s.ms, 0)
    const sites = new Map<string, { from: Spot['from']; site: string; ms: number; areas: Map<string, number> }>()
    for (const s of samples) {
      const spot = spotAt(s.lat, s.lng, plans, fences)
      if (!spot) continue
      const k = `${spot.from}|${spot.site}`
      const t = sites.get(k) ?? { from: spot.from, site: spot.site, ms: 0, areas: new Map<string, number>() }
      t.ms += s.ms
      const a = spot.area ?? ''
      t.areas.set(a, (t.areas.get(a) ?? 0) + s.ms)
      sites.set(k, t)
    }
    const top = [...sites.values()].sort((a, b) => b.ms - a.ms)[0]
    if (!top || top.ms * 2 < total) continue
    const area = [...top.areas.entries()].sort((a, b) => b[1] - a[1])[0]![0] || null
    p.exactName = spotName({ site: top.site, area })
    p.site = top.site
    p.nameFrom = top.from
    p.activity = 'Work'
    named++
  }
  return named
}
