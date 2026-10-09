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
 * The same test, run over every fix of the track, gives the Logbook's Site
 * Visits (siteVisits): when the unit went onto each site, the named areas it
 * stood in and for how long, and when it left.
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
import type { ReviewPlace, ReviewPoint, ReviewStop } from './usage-review.compute.js'
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

const haCache = new WeakMap<object, number>()
const fenceHa = (s: Site): number => {
  const f = s.fence
  if (!f) return Infinity
  let ha = haCache.get(f)
  if (ha === undefined) {
    ha = f.type === 'CIRCLE' ? (Math.PI * f.radiusM * f.radiusM) / 10_000 : f.type === 'POLYGON' ? ringAreaHa(f.polygonCoords) : Infinity
    haCache.set(f, ha)
  }
  return ha
}

/** A ring's bounding box, worked out once: a whole track is tested against
 *  every survey (siteVisits), and nearly every fix is nowhere near most. */
const boxCache = new WeakMap<Ring, [number, number, number, number]>()
function inRing(lat: number, lng: number, ring: Ring): boolean {
  let b = boxCache.get(ring)
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of ring) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y) }
    boxCache.set(ring, b)
  }
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3] && pointInPolygon(lat, lng, ring)
}
const inFence = (lat: number, lng: number, f: NonNullable<Site['fence']>) =>
  f.type === 'POLYGON' ? inRing(lat, lng, f.polygonCoords) : isInsideFence(lat, lng, f)
/** About PIN_RADIUS_M in degrees of latitude, with room: a pin further than
 *  this north or south is not measured. */
const PIN_DEG = (PIN_RADIUS_M * 1.2) / 111_000

/** Where a point stands, by the company's own ground — see the module note. */
export function spotAt(lat: number, lng: number, plans: SitePlan[], fences: Site[] = []): Spot | null {
  // 1. A surveyed site: inside its fence, or at one of its pins.
  let best: { plan: SitePlan; ha: number } | null = null
  for (const plan of plans) {
    if (!plan.perimeter || !plan.name || !inRing(lat, lng, plan.perimeter)) continue
    if (!best || plan.ha < best.ha) best = { plan, ha: plan.ha }
  }
  let pinHit: { plan: SitePlan; name: string; d: number } | null = null
  for (const plan of best ? [best.plan] : plans) {
    if (!plan.name) continue
    for (const pin of plan.pins) {
      if (Math.abs(pin.lat - lat) > PIN_DEG) continue
      const d = haversineM(lat, lng, pin.lat, pin.lng)
      if (d <= PIN_RADIUS_M && (!pinHit || d < pinHit.d)) pinHit = { plan, name: pin.name, d }
    }
  }
  if (best) {
    const area = best.plan.areas
      .filter(a => inRing(lat, lng, a.ring))
      .sort((a, b) => a.ha - b.ha)[0]?.name ?? pinHit?.name ?? null
    return { site: best.plan.name!, area, from: 'site-plan' }
  }
  if (pinHit) return { site: pinHit.plan.name!, area: pinHit.name, from: 'site-plan' }

  // 2. A surveyed area with no fence round it.
  const open = plans.filter(p => !p.perimeter).flatMap(p => p.areas)
    .filter(a => inRing(lat, lng, a.ring)).sort((a, b) => a.ha - b.ha)[0]
  if (open) return { site: open.name, area: null, from: 'site-plan' }

  // 3. The organisation's own geofences, smallest first.
  const fence = fences
    .filter(s => s.fence && fenceHa(s) <= MAX_NAMING_FENCE_HA && inFence(lat, lng, s.fence))
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

/** Name each stop by the spot it stood at on the company's ground, in place;
 *  the Logbook's Movements reads it (ReviewStop.spot). */
export function nameStops(stops: ReviewStop[], plans: SitePlan[], fences: Site[] = []): void {
  for (const s of stops) {
    const sp = spotAt(s.lat, s.lng, plans, fences)
    s.spot = sp ? spotName(sp) : null
  }
}

// ── visits ──────────────────────────────────────────────────────────────────

/** Out of a site for less than this and back in is the same visit: a fix that
 *  landed over the fence line, or a lorry out of the gate and straight back. */
export const VISIT_GAP_MS = 10 * 60_000
/** Shorter than this, a visit was a drive past (a road along the fence, a pin
 *  by the roadside) and not a visit. */
export const MIN_VISIT_MS = 5 * 60_000
/** Shorter than this, an area was driven through on the way to another. */
export const MIN_AREA_MS = 2 * 60_000
/** The site's own ground, outside every named area, takes longer to cross
 *  (out of Kabras' garage to the gate is three minutes), so a stay there
 *  counts from this. */
export const MIN_GROUND_MS = 5 * 60_000

export interface SiteVisitArea {
  /** The named area or pin; null for the site's own ground, outside every
   *  named area. */
  name: string | null
  /** First and last fix in it, ms. */
  start: number
  end: number
}

export interface SiteVisit {
  site: string
  from: Spot['from']
  /** The first fix inside the site, and the last. */
  start: number
  end: number
  /** On the site already at the period's first fix, so it arrived earlier. */
  startsBefore: boolean
  /** Still on the site at the period's last fix, so it left later, if at all. */
  endsAfter: boolean
  /** Where on the site it stood, in order, each a stay in one area. Empty for
   *  a visit that never stood in a named area. */
  areas: SiteVisitArea[]
}

/**
 * Every visit to a site in the track (operator, 2026-10-09: "when the unit was
 * able to access for instance Raiply, at what time did it arrive, which area
 * within the organisation was it seen, for how long, when it departed").
 *
 * Read from the fixes rather than the stops: a stop is a place it stood ten
 * minutes or more, but it arrives when it crosses the fence, and the areas it
 * stood in for less still count. A visit runs from the first fix inside the
 * site to the last; out of it for under VISIT_GAP_MS and back is the same
 * visit, and a silence (a tracker that sleeps while parked) does not end one.
 */
export function siteVisits(points: ReviewPoint[], plans: SitePlan[], fences: Site[] = []): SiteVisit[] {
  if (!points.length) return []
  // A parked unit sends the same fix over and over.
  const memo = new Map<string, Spot | null>()
  const spot = (lat: number, lng: number) => {
    const k = `${lat.toFixed(5)},${lng.toFixed(5)}`
    let v = memo.get(k)
    if (v === undefined) { v = spotAt(lat, lng, plans, fences); memo.set(k, v) }
    return v
  }
  const firstT = points[0]!.t, lastT = points[points.length - 1]!.t
  const out: SiteVisit[] = []
  let cur: (SiteVisit & { key: string }) | null = null

  const close = () => {
    if (!cur) return
    const { key: _key, ...v } = cur
    cur = null
    if (v.end - v.start < MIN_VISIT_MS) return
    // Areas driven through drop out, and the stays either side of one become
    // one stay; the longest is kept if every one was short.
    let kept = v.areas.filter(a => a.end - a.start >= (a.name == null ? MIN_GROUND_MS : MIN_AREA_MS))
    if (!kept.length) kept = [...v.areas].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 1)
    const merged: SiteVisitArea[] = []
    for (const a of kept) {
      const last = merged[merged.length - 1]
      if (last && last.name === a.name) last.end = a.end
      else merged.push({ ...a })
    }
    v.areas = merged.length === 1 && merged[0]!.name == null ? [] : merged
    out.push(v)
  }

  for (const p of points) {
    const s = spot(p.lat, p.lng)
    if (!s) {
      if (cur && p.t - cur.end > VISIT_GAP_MS) close()
      continue
    }
    const key = `${s.from}|${s.site}`
    if (cur && cur.key !== key) close()
    if (!cur) {
      cur = { key, site: s.site, from: s.from, start: p.t, end: p.t, startsBefore: p.t === firstT, endsAfter: false, areas: [] }
    }
    cur.end = p.t
    cur.endsAfter = p.t === lastT
    const last = cur.areas[cur.areas.length - 1]
    if (last && last.name === s.area) last.end = p.t
    else cur.areas.push({ name: s.area, start: p.t, end: p.t })
  }
  close()
  return out
}
