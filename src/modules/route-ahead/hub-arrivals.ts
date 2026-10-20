/**
 * Arrivals at a hub (operator, 2026-10-15): "optimise inbound routing and
 * arrival times — coordinating drivers returning to a
 * central hub, Naitiri to Raiply or back, Sukari to Oyani, Nyaondo, Opapo".
 *
 *   hubs    the places an organisation's runs start and end: its yard or
 *           yard/factory geofences, the factories it dispatches from, its
 *           weighbridge yards, and the destinations its dispatches name that
 *           are placed (stated, or measured from ten or more round trips).
 *   units   every unit of the organisation with a recent fix, with its
 *           live-traffic drive time to the hub (one Route Matrix request),
 *           the no-traffic time beside it, and whether its open dispatch is
 *           bound for the hub or returning to it. Ranked by arrival.
 *
 * Phase 1 (operator, 2026-10-15): each unit is free, busy or stale, and the
 * list can be narrowed to the free ones; drive times are scaled by the
 * unit's class (unit-class, measured from our own runs) since Google times a
 * car; past 60 minutes a drive time is given a band; and any spot on
 * the map can stand in for a hub — "suggest a unit" (getInboundAt).
 *
 * ## Cost
 *
 * A matrix is cached two minutes per hub and mode. (The reverse-isochrone
 * rings were removed on request, 2026-10-19.) At most MATRIX_MAX units are asked about — the
 * dispatched and returning ones first, then the nearest — and the answer says
 * how many were left out.
 */

import { NotFoundError } from '../../core/errors/errors.js'
import { AppError } from '../../core/errors/AppError.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { haversineM, YARD_RADIUS_M, type Point } from '../../lib/dispatch-trip.js'
import { getOpenTripsCached } from '../dispatches/open-trips.cache.js'
import { knownDestination } from '../dispatches/known-destinations.js'
import { getFleetSnapshotCached } from '../telemetry/fleet-snapshot.cache.js'
import { FACTORIES } from '../webhooks/factory-map.js'
import { WEIGHBRIDGES } from '../weighments/weighbridge.geography.js'
import { homeSites } from '../fuel/fuel-investigation.js'
import {
  googleRoutingAvailable, routeMatrixTo, GoogleRoutingError, MATRIX_MAX, type TravelMode,
} from '../../providers/google-routing/index.js'
import { unitClass, etaFactor, type UnitClass } from './unit-class.js'

export const ARRIVAL_MINUTES = [15, 30, 60] as const
/** A fix older than this says nothing about where the unit is now. */
const FRESH_MS = 6 * 60 * 60_000
/** Beyond this, a unit is not coming in today; not asked about. */
const FAR_M = 250_000
/** Places closer than this are one hub. */
const SAME_PLACE_M = 1_000
/** A measured destination needs this many round trips to be a hub. */
const MIN_SAMPLES = 10
const HUBS_TTL_MS = 60 * 60_000
const MATRIX_TTL_MS = 2 * 60_000

export interface Hub extends Point {
  key: string
  name: string
  kind: 'yard' | 'factory' | 'weighbridge' | 'destination' | 'point'
}

export interface Arrival {
  vehicleId: string
  plate: string | null
  lat: number
  lng: number
  fixAt: string
  speedKmh: number | null
  straightM: number
  unitClass: UnitClass
  /** By road. */
  distanceM: number
  /** Calibrated: Google's no-traffic time × the class factor, plus today's
   *  traffic delay. `googleS` is Google's own (car) answer, for comparison. */
  etaS: number
  staticS: number
  delayS: number
  googleS: number
  factor: number
  factorRuns: number
  arriveAt: string
  /** Past 60 minutes: "1–2 h", "2–4 h", "4 h+"; null inside it. */
  band: string | null
  /** free: fresh position, no open dispatch; busy: on a dispatch; stale: no position in 30 min. */
  status: 'free' | 'busy' | 'stale'
  /** The smallest drive-time band (minutes) it is inside, or null beyond them all. */
  withinMin: number | null
  /** dispatched: its open run is bound for this hub; returning: it is coming back to it. */
  run: 'dispatched' | 'returning' | null
  destination: string | null
}

export interface Inbound {
  enabled: true
  hub: Hub
  mode: TravelMode
  cls: ArrivalClass
  available: boolean
  minutes: number[]
  units: Arrival[]
  /** Inside the hub's yard now. */
  atHub: { vehicleId: string; plate: string | null }[]
  /** Asked about but with no road to the hub. */
  noRoute: number
  /** Not asked about: too far, or past the per-request cap. */
  leftOut: number
  /** Left out by "available only": busy or stale. */
  filteredOut: number
  computedAt: string
}

const hubsCache = new Map<string, { at: number; hubs: Hub[] }>()
const matrixCache = new Map<string, { at: number; out: Omit<Inbound, 'hub'> }>()
const inflight = new Map<string, Promise<unknown>>()

function remember<V>(m: Map<string, V>, k: string, v: V) {
  m.delete(k); m.set(k, v)
  if (m.size > 2_000) m.delete(m.keys().next().value as string)
}
function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key)
  if (hit) return hit as Promise<T>
  const p = run().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const title = (n: string) => n.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase())
const tidy = (s: string) => s.replace(/\s+(Limited|Ltd\.?)$/i, '').trim()

/** The organisation's hubs, in priority order: a nearer duplicate is dropped. */
export async function getHubs(orgId: string): Promise<Hub[]> {
  const now = Date.now()
  const hit = hubsCache.get(orgId)
  if (hit && now - hit.at < HUBS_TTL_MS) return hit.hubs

  const org = await prisma.organisation.findUnique({
    where: { id: orgId }, select: { code: true, name: true, hubLat: true, hubLng: true },
  })
  if (!org) throw new NotFoundError('Organisation')
  const since = new Date(now - 30 * 86_400_000)
  const recent = await prisma.dispatch.findMany({
    where: { organisationId: orgId, dispatchedAt: { gte: since } },
    distinct: ['destination', 'factoryCode'],
    select: { destination: true, factoryCode: true },
  })

  const cands: Omit<Hub, 'key'>[] = []
  if (org.hubLat != null && org.hubLng != null) cands.push({ name: tidy(org.name), lat: org.hubLat, lng: org.hubLng, kind: 'yard' })
  else for (const s of await homeSites(orgId, now)) cands.push({ name: s.name ?? 'Yard', lat: s.lat, lng: s.lng, kind: 'yard' })

  const gates = new Set(recent.map((d) => d.factoryCode).filter(Boolean) as string[])
  for (const [code, f] of Object.entries(FACTORIES)) {
    if (f.orgCode === org.code || gates.has(code)) cands.push({ name: `${f.label} Factory`, lat: f.lat, lng: f.lng, kind: 'factory' })
  }
  const yards = new Map<string, { lat: number; lng: number }>()
  for (const w of WEIGHBRIDGES) if (w.orgCode === org.code && !yards.has(w.centerName)) yards.set(w.centerName, w)
  for (const [name, w] of yards) cands.push({ name: title(name), lat: w.lat, lng: w.lng, kind: 'weighbridge' })

  const names = [...new Set(recent.map((d) => d.destination?.trim().toUpperCase()).filter(Boolean) as string[])]
  const measured = names.length
    ? await prisma.dispatchDestination.findMany({
        where: { organisationId: orgId, name: { in: names }, samples: { gte: MIN_SAMPLES } },
        select: { name: true, lat: true, lng: true },
      })
    : []
  for (const n of names) {
    const k = knownDestination(n)
    if (k) cands.push({ name: k.label, lat: k.lat, lng: k.lng, kind: 'destination' })
  }
  for (const m of measured) cands.push({ name: title(m.name), lat: m.lat, lng: m.lng, kind: 'destination' })

  const hubs: Hub[] = []
  for (const c of cands) {
    // One place, or one name: Opapo's weighbridge and the Opapo its runs are
    // measured to are 5 km apart, and two "Opapo" hubs would read as a bug.
    if (hubs.some((h) => haversineM(h, c) < SAME_PLACE_M || h.name.toLowerCase() === c.name.toLowerCase())) continue
    let key = `${c.kind}-${slug(c.name)}`
    while (hubs.some((h) => h.key === key)) key += '-2'
    hubs.push({ ...c, key })
  }
  remember(hubsCache, orgId, { at: now, hubs })
  return hubs
}

const googleError = (err: unknown) =>
  err instanceof GoogleRoutingError ? `Google: ${err.message}`
    : (err as Error)?.name === 'TimeoutError' ? 'Google did not answer in time'
    : 'Google could not be reached'

/**
 * What the drive times are for. A unit class times every unit in it by that
 * class's measured factor; `all` times each unit by its own class; VEHICLE is
 * every unit that is not a tractor (trucks and cars, each at its own factor),
 * the window's "Truck or car"; PLANT is the register's excavators, dozers,
 * loaders, graders, cranes (KASULU); MOTORBIKE is Google's two-wheeler mode,
 * uncalibrated. A FIXED unit (a generator) is in none of them.
 */
export type ArrivalClass = 'all' | 'VEHICLE' | 'TRACTOR' | 'TRUCK' | 'CAR' | 'PLANT' | 'MOTORBIKE'

/** Whether a unit of class `c` belongs in the list for `cls`. */
export function inArrivalClass(c: UnitClass, cls: ArrivalClass): boolean {
  if (c === 'FIXED') return false
  if (cls === 'all' || cls === 'MOTORBIKE') return true
  if (cls === 'VEHICLE') return c === 'TRUCK' || c === 'CAR'
  return c === cls
}

/** The window's classes, and how many of the fleet's units each holds. */
export const WINDOW_CLASSES = ['VEHICLE', 'TRACTOR', 'PLANT'] as const
export type WindowClass = typeof WINDOW_CLASSES[number]

export function classCounts(rows: SnapRow[]): Record<WindowClass, number> {
  const out: Record<WindowClass, number> = { VEHICLE: 0, TRACTOR: 0, PLANT: 0 }
  for (const r of rows) {
    const c = snapClass(r)
    for (const w of WINDOW_CLASSES) if (inArrivalClass(c, w)) out[w]++
  }
  return out
}

export async function getArrivalClasses(orgId: string): Promise<Record<WindowClass, number>> {
  const snap = await getFleetSnapshotCached(orgId)
  return classCounts((Array.isArray(snap) ? snap : []) as unknown as SnapRow[])
}

/** Past this, a drive time is given a band instead. */
const BAND_FROM_MIN = 60

export interface SnapRow {
  vehicleId: string; name: string | null; vehicleType: string | null
  /** RaiFactorySuite's register (KASULU), null elsewhere. */
  equipmentType?: string | null; ratedConsumptionBasis?: string | null
  lat: number | null; lng: number | null; speedKmh: number | null; capturedAt: string | null
}

const snapClass = (r: SnapRow): UnitClass =>
  unitClass(r.vehicleType, r.name, { equipmentType: r.equipmentType, ratedConsumptionBasis: r.ratedConsumptionBasis })

/** Over this, a unit's position is too old to dispatch it on. */
const AVAILABLE_FIX_MS = 30 * 60_000

/** A drive time past an hour, in words: "1–2 h", "2–4 h", "4 h+". */
export function etaBand(etaS: number): string | null {
  if (etaS <= BAND_FROM_MIN * 60) return null
  if (etaS <= 2 * 3600) return '1–2 h'
  if (etaS <= 4 * 3600) return '2–4 h'
  return '4 h+'
}

/**
 * Whether a unit can be sent: `free` (a fresh position and no open dispatch),
 * `busy` (on a dispatch) or `stale` (no position in the last half hour).
 */
export function availability(fixAtMs: number, onRun: boolean, now: number): Arrival['status'] {
  if (onRun) return 'busy'
  return now - fixAtMs > AVAILABLE_FIX_MS ? 'stale' : 'free'
}

async function arrivals(
  orgId: string, hub: Point, minutes: number[], cls: ArrivalClass, availableOnly: boolean, now: number,
): Promise<Omit<Inbound, 'hub'>> {
  const [snap, open] = await Promise.all([getFleetSnapshotCached(orgId), getOpenTripsCached(orgId)])
  const rows = (Array.isArray(snap) ? snap : []) as unknown as SnapRow[]
  const mode: TravelMode = cls === 'MOTORBIKE' ? 'TWO_WHEELER' : 'DRIVE'

  const atHub: Inbound['atHub'] = []
  type Cand = SnapRow & { lat: number; lng: number; straightM: number; run: Arrival['run']; destination: string | null; cls: UnitClass; status: Arrival['status'] }
  const cands: Cand[] = []
  let leftOut = 0
  let filteredOut = 0
  for (const r of rows) {
    if (r.lat == null || r.lng == null || !r.capturedAt) continue
    const fixMs = Date.parse(r.capturedAt)
    if (now - fixMs > FRESH_MS) continue
    const c = snapClass(r)
    if (!inArrivalClass(c, cls)) continue
    const straightM = haversineM(hub, { lat: r.lat, lng: r.lng })
    if (straightM <= YARD_RADIUS_M) { atHub.push({ vehicleId: r.vehicleId, plate: r.name }); continue }
    const trip = open.byVehicle.get(r.vehicleId)
    let run: Arrival['run'] = null
    if (trip) {
      const dest = trip.destinationLat != null && trip.destinationLng != null ? { lat: trip.destinationLat, lng: trip.destinationLng } : null
      const gateLat = trip.originLat ?? open.yard?.lat
      const gateLng = trip.originLng ?? open.yard?.lng
      const gate = gateLat != null && gateLng != null ? { lat: gateLat, lng: gateLng } : null
      if (trip.arrivedAt == null && dest && haversineM(dest, hub) < SAME_PLACE_M) run = 'dispatched'
      else if (trip.arrivedAt != null && gate && haversineM(gate, hub) < SAME_PLACE_M) run = 'returning'
    }
    const status = availability(fixMs, Boolean(trip), now)
    if (availableOnly && status !== 'free') { filteredOut++; continue }
    if (straightM > FAR_M && !run) { leftOut++; continue }
    cands.push({ ...r, lat: r.lat, lng: r.lng, straightM, run, destination: trip?.destination ?? null, cls: c, status })
  }
  // Bound for this hub first, then the free ones, then by distance: the
  // per-request cap goes to the units that can actually be sent.
  const rank = (c: Cand) => (c.run ? 0 : c.status === 'free' ? 1 : 2)
  cands.sort((a, b) => rank(a) - rank(b) || a.straightM - b.straightM)
  const asked = cands.slice(0, MATRIX_MAX)
  leftOut += cands.length - asked.length

  const cells = await routeMatrixTo(asked.map((c) => ({ lat: c.lat, lng: c.lng })), hub, mode)
  const units: Arrival[] = cells.map((cell) => {
    const c = asked[cell.index]!
    const f = cls === 'MOTORBIKE' ? { factor: 1, runs: 0 } : etaFactor(c.cls)
    const staticS = Math.round(cell.staticDurationS * f.factor)
    const delayS = Math.max(0, Math.round(cell.durationS - cell.staticDurationS))
    const etaS = staticS + delayS
    return {
      vehicleId: c.vehicleId,
      plate: c.name,
      unitClass: c.cls,
      lat: c.lat,
      lng: c.lng,
      fixAt: c.capturedAt!,
      speedKmh: c.speedKmh,
      straightM: Math.round(c.straightM),
      distanceM: cell.distanceM,
      etaS,
      staticS,
      delayS,
      googleS: Math.round(cell.durationS),
      factor: f.factor,
      factorRuns: f.runs,
      arriveAt: new Date(now + etaS * 1000).toISOString(),
      withinMin: minutes.find((m) => etaS <= m * 60) ?? null,
      band: etaBand(etaS),
      run: c.run,
      status: c.status,
      destination: c.destination,
    }
  }).sort((a, b) => a.etaS - b.etaS)

  return {
    enabled: true, mode, cls, available: availableOnly, minutes,
    units, atHub,
    noRoute: asked.length - cells.length,
    leftOut,
    filteredOut,
    computedAt: new Date(now).toISOString(),
  }
}

export interface InboundOpts { minutes: number[]; cls: ArrivalClass; available: boolean }

async function inbound(orgId: string, hub: Hub, opts: InboundOpts): Promise<Inbound> {
  const now = Date.now()
  const minutes = [...opts.minutes].sort((a, b) => a - b)
  const mk = `${orgId}:${hub.lat.toFixed(4)},${hub.lng.toFixed(4)}:${opts.cls}:${opts.available ? 1 : 0}:${minutes.join(',')}`
  const hit = matrixCache.get(mk)
  try {
    const out = hit && now - hit.at < MATRIX_TTL_MS
      ? hit.out
      : await shared(`matrix:${mk}`, async () => {
          const o = await arrivals(orgId, hub, minutes, opts.cls, opts.available, now)
          remember(matrixCache, mk, { at: now, out: o })
          return o
        })
    return { ...out, hub }
  } catch (err) {
    logger.warn({ err, hub: hub.key }, 'Arrivals: route matrix failed')
    throw new AppError(googleError(err), 502)
  }
}

export async function getInbound(orgId: string, hubKey: string, opts: InboundOpts): Promise<Inbound | { enabled: false }> {
  if (!googleRoutingAvailable()) return { enabled: false }
  const hub = (await getHubs(orgId)).find((h) => h.key === hubKey)
  if (!hub) throw new NotFoundError('Hub')
  return inbound(orgId, hub, opts)
}

/**
 * "Suggest a unit": the same answer for a spot picked on the map — a farm
 * with no name yet, a breakdown, a load waiting by the road. Rounded to
 * ~100 m so a second click beside the first reuses its answer.
 */
export async function getInboundAt(
  orgId: string, point: Point & { name?: string | null }, opts: InboundOpts,
): Promise<Inbound | { enabled: false }> {
  if (!googleRoutingAvailable()) return { enabled: false }
  const lat = Math.round(point.lat * 1000) / 1000
  const lng = Math.round(point.lng * 1000) / 1000
  return inbound(orgId, { key: `point-${lat},${lng}`, name: point.name?.trim() || 'Picked spot', lat, lng, kind: 'point' }, opts)
}
