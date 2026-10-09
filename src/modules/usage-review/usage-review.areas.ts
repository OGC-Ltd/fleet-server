/**
 * Where the time went, by KIND of place (operator, 2026-10-08: the Logbook
 * must show whether a unit spends its time at work, outside the working
 * areas, or at the driver's house).
 *
 *   · work      — within SITE_RADIUS_M of one of the company's known sites
 *                 (the factories and weighbridge yards this server already
 *                 places), or inside one of the organisation's own geofences
 *                 that is an area — corridors (roads) and regions larger than
 *                 MAX_FENCE_HA are not work sites;
 *   · home      — the place away from work where the unit spends the most
 *                 NIGHTS (a stop covering 02:00 EAT), once it has at least
 *                 HOME_MIN_NIGHTS of them, plus every other non-work place
 *                 within HOME_RADIUS_M of it. Nothing names a driver's house,
 *                 so this is "where it sleeps away from work" — the PDF says so;
 *   · elsewhere — every other place: outside the working areas, by day.
 *
 * Pure apart from loadSites: places and stops in, kinds out.
 */

import { prisma } from '../../lib/prisma.js'
import { haversineM, isInsideFence, type FenceGeometry } from '../../lib/geofence.js'
import { ringAreaHa } from '../../lib/zone-taxonomy.js'
import { WEIGHBRIDGES } from '../weighments/weighbridge.geography.js'
import { FACTORIES } from '../webhooks/factory-map.js'
import { TZ_OFFSET_MS, type ReviewPlace, type ReviewStop } from './usage-review.compute.js'

export const SITE_RADIUS_M = 1_500
export const HOME_RADIUS_M = 3_000
export const HOME_MIN_NIGHTS = 3
/** A fence bigger than this is a region ("Selia Region", a town), not a site. */
export const MAX_FENCE_HA = 2_000
/** The hour a stop must cover to count as the night's stop, EAT. */
export const NIGHT_HOUR = 2

export type PlaceKind = 'work' | 'home' | 'elsewhere'

export interface Site {
  name: string
  /** A point site, matched within SITE_RADIUS_M… */
  lat?: number
  lng?: number
  /** …or a fence, matched by containment. */
  fence?: FenceGeometry
}

export interface NightRow { date: string; kind: PlaceKind | null; place: number | null }

export interface AreaSummary {
  hours: Record<PlaceKind, number>
  nights: Record<PlaceKind, number>
  /** One row per calendar day of the period: where the unit stood at 02:00. */
  nightly: NightRow[]
  /** The place the home area is centred on, or null when there is none. */
  homePlace: number | null
}

export interface PlaceArea { kind: PlaceKind; site: string | null; nights: number }

const DAY = 86_400_000
const nightAt = (date: string) => Date.parse(`${date}T${String(NIGHT_HOUR).padStart(2, '0')}:00:00.000Z`) - TZ_OFFSET_MS

/** The site a point stands at, or null. */
export function siteAt(lat: number, lng: number, sites: Site[]): string | null {
  for (const s of sites) {
    if (s.fence ? isInsideFence(lat, lng, s.fence)
      : s.lat != null && s.lng != null && haversineM(lat, lng, s.lat, s.lng) <= SITE_RADIUS_M) return s.name
  }
  return null
}

/** The calendar days of the period, EAT, from..to inclusive. */
function daysOf(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

export function classifyPlaces(
  places: ReviewPlace[], stops: ReviewStop[], period: { from: string; to: string }, sites: Site[],
): { byPlace: Map<number, PlaceArea>; summary: AreaSummary } {
  const days = daysOf(period.from, period.to)

  // Where the unit stood at 02:00 each night.
  const nightPlace = new Map<string, number>()
  for (const d of days) {
    const t = nightAt(d)
    const st = stops.find(s => s.start <= t && s.end >= t)
    if (st) nightPlace.set(d, st.place)
  }
  const nightsAt = new Map<number, number>()
  for (const p of nightPlace.values()) nightsAt.set(p, (nightsAt.get(p) ?? 0) + 1)

  const byPlace = new Map<number, PlaceArea>()
  for (const p of places) {
    // Named by a site plan or a geofence: on the company's own ground, so at
    // work (usage-review.siteplans), whatever the coordinate tables say.
    const site = (p.nameFrom && p.site ? p.site : null)
      ?? siteAt(p.lat, p.lng, sites)
      ?? (p.exactName && WORK_NAME.test(p.exactName) ? p.exactName : null)
      ?? (p.name && WORK_AREA.test(p.name) ? p.name : null)
    byPlace.set(p.id, { kind: site ? 'work' : 'elsewhere', site, nights: nightsAt.get(p.id) ?? 0 })
  }

  // Home: the non-work place with the most nights, and its neighbours.
  const anchor = places
    .filter(p => byPlace.get(p.id)!.kind !== 'work' && (nightsAt.get(p.id) ?? 0) >= HOME_MIN_NIGHTS)
    .sort((a, b) => (nightsAt.get(b.id) ?? 0) - (nightsAt.get(a.id) ?? 0) || b.hours - a.hours)[0] ?? null
  if (anchor) {
    for (const p of places) {
      const a = byPlace.get(p.id)!
      if (a.kind !== 'work' && haversineM(p.lat, p.lng, anchor.lat, anchor.lng) <= HOME_RADIUS_M) a.kind = 'home'
    }
  }

  const hours: Record<PlaceKind, number> = { work: 0, home: 0, elsewhere: 0 }
  for (const p of places) hours[byPlace.get(p.id)!.kind] += p.hours
  const nights: Record<PlaceKind, number> = { work: 0, home: 0, elsewhere: 0 }
  const nightly: NightRow[] = days.map(date => {
    const place = nightPlace.get(date) ?? null
    const kind = place != null ? byPlace.get(place)?.kind ?? null : null
    if (kind) nights[kind] += 1
    return { date, kind, place }
  })
  return { byPlace, summary: { hours, nights, nightly, homePlace: anchor?.id ?? null } }
}

// ── the company's sites ──────────────────────────────────────────────────────

/**
 * A Google name that says the place is a company site: a sugar company, a
 * factory, weighbridge, workshop, yard, depot or mill. Operator, 2026-10-08:
 * 0.03284, 34.15056 is West Kenya Sugar's Lake Agro workshop — a work site
 * the coordinate tables did not hold, and the classifier had called "home".
 */
export const WORK_NAME = /\b(sugar|sukari|kabras|nzoia|factory|weighbridge|workshop|yard|depot|mill)\b/i

/**
 * Areas the operator has named as work areas, matched on the place's
 * OpenStreetMap area name ("Hirimani, Bura"): a unit stopped anywhere OSM
 * calls by that name is at work. Operator, 2026-10-09: "Hirimani Bura, that
 * is work area".
 */
export const WORK_AREA = /\bhirimani\b/i

export const STATIC_SITES: Site[] = [
  // Operator-given (2026-10-08): West Kenya Sugar's Lake Agro workshop.
  { name: 'West Kenya Sugar - Lake Agro workshop', lat: 0.03284, lng: 34.15056 },
  // Operator-named (2026-10-09): the Hirimani work area, Bura, Tana River —
  // OpenStreetMap's village point and 3 km round it: an area, not a yard.
  { name: 'Hirimani work area, Bura', fence: { type: 'CIRCLE', centerLat: -1.11953, centerLng: 39.82372, radiusM: 3_000 } },
  ...Object.values(FACTORIES).map(f => ({ name: `${f.label} factory`, lat: f.lat, lng: f.lng })),
  ...WEIGHBRIDGES.map(b => ({ name: `${b.centerName.charAt(0)}${b.centerName.slice(1).toLowerCase()} ${b.label}`, lat: b.lat, lng: b.lng })),
]

/**
 * Every site a unit of `orgId` can be at work at: the factories and yards
 * placed in code (all of them — a lorry at another mill's yard is working),
 * then the organisation's own area fences. Corridors are roads, and a stop on
 * a road is not a stop at work; regions over MAX_FENCE_HA would swallow towns.
 */
export async function loadSites(orgId: string): Promise<Site[]> {
  return [...await loadFences(orgId), ...STATIC_SITES]
}

/** The organisation's own area fences — loadSites without the sites placed in
 *  code. These are names the company gave its ground, so they can name a place
 *  (usage-review.siteplans); a factory matched within 1.5 km cannot. */
export async function loadFences(orgId: string): Promise<Site[]> {
  const rows = await prisma.geofence.findMany({
    where: { organisationId: orgId, type: { in: ['CIRCLE', 'POLYGON'] } },
    select: { name: true, type: true, centerLat: true, centerLng: true, radiusM: true, polygonCoords: true },
  })
  const fences: Site[] = []
  for (const r of rows) {
    if (r.type === 'CIRCLE' && r.centerLat != null && r.centerLng != null && r.radiusM != null) {
      fences.push({ name: r.name, fence: { type: 'CIRCLE', centerLat: r.centerLat, centerLng: r.centerLng, radiusM: r.radiusM } })
    } else if (r.type === 'POLYGON' && Array.isArray(r.polygonCoords)) {
      const ring = r.polygonCoords as [number, number][]
      if (ring.length >= 3 && ringAreaHa(ring) <= MAX_FENCE_HA) fences.push({ name: r.name, fence: { type: 'POLYGON', polygonCoords: ring } })
    }
  }
  return fences
}
