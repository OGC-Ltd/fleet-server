/**
 * The movement report: where every unit is now, and whether it is heading to
 * MORL or away from it (operator, 2026-11-01: "2 hours and 4 hours reports on
 * vehicles location indicating if it's heading to MORL or from MORL").
 *
 * One row per unit, in the operator's sheet's columns: grouping (the unit's
 * own name, "CPO - Menengai - KCV 039A"), last coordinates (when the last fix
 * was), location, speed and direction. Units are organised by the grouping
 * prefix ("CPO - Menengai"), CPO first.
 *
 * Direction is measured, not guessed: the unit's distance to the MORL
 * geofence at the start of the window (2 or 4 hours ago) against now. Closer
 * by a kilometre or more is "to MORL", further is "from MORL"; inside the
 * fence is "at MORL". MORL is the organisation's geofence whose name says
 * MORL, so the report needs nothing configured beyond that fence.
 */
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { haversineM, isInsideFence, type FenceGeometry } from '../../lib/geofence.js'
import { cachedPlace, reverseGeocode } from '../../lib/geocode.js'
import { getFleetSnapshotCached } from '../telemetry/fleet-snapshot.cache.js'

export const WINDOW_HOURS = [2, 4] as const
export type WindowHours = (typeof WINDOW_HOURS)[number]

/** A change in distance to MORL smaller than this is not a direction. */
const DIRECTION_MIN_KM = 1
/** Moving: this fast or faster. A moving unit's location is printed green. */
export const MOVING_KMH = 5
/** Reverse lookups for places not yet cached: Nominatim answers one a second. */
const MAX_PLACE_LOOKUPS = 15
const PLACE_LOOKUP_WAIT_MS = 15_000

export type MovementState = 'to' | 'from' | 'at' | 'moving' | 'stopped' | 'no-fix'

export interface Fix { lat: number; lng: number; at: number; speedKmh: number | null }

export interface MorlFence { name: string; geometry: FenceGeometry; centre: { lat: number; lng: number } }

/**
 * Where a unit stands relative to MORL. Pure.
 * @param start the unit's first fix in the window, or null when it sent none
 */
export function classify(last: Fix | null, start: { lat: number; lng: number } | null, morl: MorlFence | null): {
  state: MovementState; kmToMorl: number | null; closerKm: number | null
} {
  if (!last) return { state: 'no-fix', kmToMorl: null, closerKm: null }
  const moving = (last.speedKmh ?? 0) >= MOVING_KMH
  if (!morl) return { state: moving ? 'moving' : 'stopped', kmToMorl: null, closerKm: null }
  if (isInsideFence(last.lat, last.lng, morl.geometry)) return { state: 'at', kmToMorl: 0, closerKm: null }
  const km = (p: { lat: number; lng: number }) => haversineM(p.lat, p.lng, morl.centre.lat, morl.centre.lng) / 1000
  const kmToMorl = Math.round(km(last) * 10) / 10
  if (!start) return { state: moving ? 'moving' : 'stopped', kmToMorl, closerKm: null }
  const closerKm = Math.round((km(start) - km(last)) * 10) / 10
  if (closerKm >= DIRECTION_MIN_KM) return { state: 'to', kmToMorl, closerKm }
  if (closerKm <= -DIRECTION_MIN_KM) return { state: 'from', kmToMorl, closerKm }
  return { state: moving ? 'moving' : 'stopped', kmToMorl, closerKm }
}

/**
 * The grouping a unit's name carries before its plate: "CPO - Menengai - KCV
 * 039A" → "CPO - Menengai"; "CPO - Menengai KCN 912F" → "CPO - Menengai".
 * Null when the name is only the plate.
 */
export function groupingOf(name: string | null, plate: string | null): string | null {
  if (!name) return null
  let rest = name.trim()
  if (plate) {
    // The plate as written in the name, spaces optional: "KCV 039A" or "KCV039A".
    const loose = plate.replace(/\s+/g, '').split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')
    const m = new RegExp(`${loose}.*$`, 'i').exec(rest)
    if (m) rest = rest.slice(0, m.index)
  } else {
    rest = rest.replace(/\s*-\s*[^-]+$/, '')
  }
  rest = rest.replace(/[\s\-–·]+$/, '').trim()
  return rest || null
}

/** Groups in report order: CPO first, then by name. */
export function groupOrder(a: string, b: string): number {
  const cpo = (s: string) => (/^CPO\b/i.test(s) ? 0 : 1)
  return cpo(a) - cpo(b) || a.localeCompare(b)
}

/** Within a group: heading to MORL, leaving it, moving, stopped, at MORL, then no fix. */
const STATE_RANK: Record<MovementState, number> = { to: 0, from: 1, moving: 2, stopped: 3, at: 4, 'no-fix': 5 }

export interface MovementRow {
  vehicleId: string
  plate: string
  /** The unit's own name, as the sheet's Grouping column shows it. */
  grouping: string
  lastAt: number | null
  lat: number | null
  lng: number | null
  location: string | null
  speedKmh: number | null
  state: MovementState
  kmToMorl: number | null
  /** Positive: closer to MORL than at the start of the window. */
  closerKm: number | null
  /** The last fix is older than the window: the unit has not reported in it. */
  stale: boolean
}

export interface MovementReport {
  organisation: string
  orgCode: string
  hours: WindowHours
  from: number
  to: number
  morl: string | null
  groups: Array<{ name: string; rows: MovementRow[] }>
  counts: Record<MovementState, number> & { stale: number; total: number }
}

/** The organisation's MORL fence: by name, as drawn on the map. */
async function findMorl(orgId: string): Promise<MorlFence | null> {
  const fences = await prisma.geofence.findMany({
    where:  { organisationId: orgId, isActive: true, name: { contains: 'MORL', mode: 'insensitive' } },
    select: { name: true, type: true, centerLat: true, centerLng: true, radiusM: true, polygonCoords: true, widthM: true },
    orderBy: { name: 'asc' },
  })
  // The one named MORL itself, before "MORL Farm" and the like.
  const pick = fences.find(f => /^\s*MORL\s*$/i.test(f.name)) ?? fences.find(f => /\bMORL\b/i.test(f.name) && !/farm/i.test(f.name)) ?? fences[0]
  if (!pick) return null
  if (pick.type === 'CIRCLE' && pick.centerLat != null && pick.centerLng != null && pick.radiusM != null) {
    return { name: pick.name, geometry: { type: 'CIRCLE', centerLat: pick.centerLat, centerLng: pick.centerLng, radiusM: pick.radiusM },
             centre: { lat: pick.centerLat, lng: pick.centerLng } }
  }
  const coords = pick.polygonCoords as [number, number][] | null
  if (!coords?.length) return null
  const centre = { lat: coords.reduce((n, c) => n + c[1], 0) / coords.length, lng: coords.reduce((n, c) => n + c[0], 0) / coords.length }
  const geometry: FenceGeometry = pick.type === 'LINE' && pick.widthM != null
    ? { type: 'LINE', pathCoords: coords, widthM: pick.widthM }
    : { type: 'POLYGON', polygonCoords: coords }
  return { name: pick.name, geometry, centre }
}

/** Place names for the rows: cached first, then a few paced lookups, bounded in time. */
async function nameRows(rows: MovementRow[]) {
  for (const r of rows) if (r.lat != null && r.lng != null && r.state !== 'at') r.location = cachedPlace(r.lat, r.lng)
  const miss = rows.filter(r => r.lat != null && r.lng != null && r.state !== 'at' && !r.location).slice(0, MAX_PLACE_LOOKUPS)
  if (miss.length) {
    await Promise.race([
      Promise.all(miss.map(async r => { r.location = await reverseGeocode(r.lat!, r.lng!).catch(() => null) })),
      new Promise(resolve => setTimeout(resolve, PLACE_LOOKUP_WAIT_MS).unref?.()),
    ])
  }
  for (const r of rows) if (!r.location && r.lat != null && r.lng != null && r.state !== 'at') r.location = `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`
}

export async function getMovementReport(orgId: string, hours: WindowHours, vehicleIds: Set<string> | null = null): Promise<MovementReport> {
  const to = Date.now()
  const from = to - hours * 3_600_000
  const [org, snapshot, morl] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true, code: true } }),
    getFleetSnapshotCached(orgId),
    findMorl(orgId),
  ])
  const units = snapshot.filter(v => !vehicleIds || vehicleIds.has(v.vehicleId))

  // Each unit's first fix in the window: where it was when the window began.
  const ids = units.map(u => u.vehicleId)
  const starts = ids.length
    ? await prisma.$queryRaw<Array<{ vehicle_id: string; lat: number; lng: number }>>`
        SELECT DISTINCT ON (vehicle_id) vehicle_id, lat, lng
          FROM vehicle_telemetries
         WHERE vehicle_id = ANY(${ids}::text[]) AND captured_at >= ${new Date(from)} AND captured_at <= ${new Date(to)}
           AND lat IS NOT NULL AND lng IS NOT NULL
         ORDER BY vehicle_id, captured_at ASC`.catch((err) => {
          logger.warn({ err, orgId }, 'movement report: window start fixes failed — directions left blank')
          return []
        })
    : []
  const startOf = new Map(starts.map(s => [s.vehicle_id, { lat: s.lat, lng: s.lng }]))

  const rows: MovementRow[] = units.map(u => {
    const lastAt = u.capturedAt ? Date.parse(u.capturedAt) : null
    const last: Fix | null = u.lat != null && u.lng != null && lastAt != null ? { lat: u.lat, lng: u.lng, at: lastAt, speedKmh: u.speedKmh } : null
    const c = classify(last, startOf.get(u.vehicleId) ?? null, morl)
    return {
      vehicleId: u.vehicleId, plate: u.plate, grouping: u.name?.trim() || u.plate,
      lastAt, lat: u.lat, lng: u.lng, location: c.state === 'at' ? (morl?.name ?? 'MORL') : null,
      speedKmh: u.speedKmh != null ? Math.round(u.speedKmh) : null,
      state: c.state, kmToMorl: c.kmToMorl, closerKm: c.closerKm,
      stale: lastAt != null && lastAt < from,
    }
  })
  await nameRows(rows)

  const byGroup = new Map<string, { name: string; rows: MovementRow[] }>()
  for (const r of rows) {
    const label = groupingOf(r.grouping, r.plate) ?? 'Other'
    const key = label.toUpperCase().replace(/\s+/g, ' ')
    const g = byGroup.get(key) ?? { name: label, rows: [] }
    g.rows.push(r)
    byGroup.set(key, g)
  }
  const groups = [...byGroup.values()].sort((a, b) => groupOrder(a.name, b.name))
  for (const g of groups) {
    g.rows.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]
      || (a.state === 'to' || a.state === 'from' ? (b.speedKmh ?? 0) - (a.speedKmh ?? 0) : (a.lastAt ?? 0) - (b.lastAt ?? 0))
      || a.plate.localeCompare(b.plate))
  }

  return { organisation: org?.name ?? '', orgCode: org?.code ?? '', hours, from, to, morl: morl?.name ?? null, groups, counts: countRows(groups) }
}

/** The overview's figures, from whatever rows the report holds. Pure. */
export function countRows(groups: MovementReport['groups']): MovementReport['counts'] {
  const counts = { to: 0, from: 0, at: 0, moving: 0, stopped: 0, 'no-fix': 0, stale: 0, total: 0 }
  for (const g of groups) for (const r of g.rows) { counts[r.state]++; counts.total++; if (r.stale) counts.stale++ }
  return counts
}

/**
 * The report as the operator edited it on the Reports page (2026-11-02):
 * their rows, locations and directions, with the organisation's name taken
 * from the database rather than the request, empty groups dropped and the
 * overview counted again from what is left.
 */
export async function editedMovementReport(
  orgId: string,
  edited: Pick<MovementReport, 'hours' | 'from' | 'to' | 'morl' | 'groups'>,
): Promise<MovementReport> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true, code: true } })
  const groups = edited.groups.filter(g => g.rows.length)
  return { organisation: org?.name ?? '', orgCode: org?.code ?? '', hours: edited.hours, from: edited.from, to: edited.to,
           morl: edited.morl, groups, counts: countRows(groups) }
}
