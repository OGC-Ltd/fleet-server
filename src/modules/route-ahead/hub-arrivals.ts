/**
 * Arrivals at a hub (operator, 2026-10-15): "reverse isochrones to optimise
 * inbound routing and arrival times — coordinating drivers returning to a
 * central hub, Naitiri to Raiply or back, Sukari to Oyani, Nyaondo, Opapo".
 *
 *   hubs    the places an organisation's runs start and end: its yard or
 *           yard/factory geofences, the factories it dispatches from, its
 *           weighbridge yards, and the destinations its dispatches name that
 *           are placed (stated, or measured from ten or more round trips).
 *   rings   REVERSE isochrones (Google, travelDirection TO, live traffic):
 *           every place from which the hub can be reached within 15, 30 and
 *           60 minutes right now. Inbound service zones, not a radius.
 *   units   every unit of the organisation with a recent fix, with its
 *           live-traffic drive time to the hub (one Route Matrix request),
 *           the no-traffic time beside it, and whether its open dispatch is
 *           bound for the hub or returning to it. Ranked by arrival.
 *
 * ## Cost
 *
 * Rings are cached ten minutes per hub, mode and minutes; a matrix two
 * minutes per hub and mode. At most MATRIX_MAX units are asked about — the
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
  googleRoutingAvailable, isochrone, routeMatrixTo, GoogleRoutingError, MATRIX_MAX, type TravelMode,
} from '../../providers/google-routing/index.js'

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
const RINGS_TTL_MS = 10 * 60_000
const MATRIX_TTL_MS = 2 * 60_000

export interface Hub extends Point {
  key: string
  name: string
  kind: 'yard' | 'factory' | 'weighbridge' | 'destination'
}

export interface Arrival {
  vehicleId: string
  plate: string | null
  lat: number
  lng: number
  fixAt: string
  speedKmh: number | null
  straightM: number
  /** By road, live traffic. */
  distanceM: number
  etaS: number
  /** The same drive with no traffic; `delayS` is the difference. */
  staticS: number
  delayS: number
  arriveAt: string
  /** The smallest ring it is inside by drive time, or null beyond them all. */
  withinMin: number | null
  /** dispatched: its open run is bound for this hub; returning: it is coming back to it. */
  run: 'dispatched' | 'returning' | null
  destination: string | null
}

export interface Inbound {
  enabled: true
  hub: Hub
  mode: TravelMode
  minutes: number[]
  rings: { minutes: number; geometry: unknown }[]
  ringsReason: string | null
  units: Arrival[]
  /** Inside the hub's yard now. */
  atHub: { vehicleId: string; plate: string | null }[]
  /** Asked about but with no road to the hub. */
  noRoute: number
  /** Not asked about: too far, or past the per-request cap. */
  leftOut: number
  computedAt: string
}

const hubsCache = new Map<string, { at: number; hubs: Hub[] }>()
const ringCache = new Map<string, { at: number; geometry: unknown }>()
const matrixCache = new Map<string, { at: number; out: Omit<Inbound, 'rings' | 'ringsReason'> }>()
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

async function rings(hub: Hub, minutes: number[], mode: TravelMode, now: number) {
  return Promise.all(minutes.map(async (m) => {
    const key = `${hub.lat.toFixed(5)},${hub.lng.toFixed(5)}:${mode}:${m}`
    const hit = ringCache.get(key)
    if (hit && now - hit.at < RINGS_TTL_MS) return { minutes: m, geometry: hit.geometry }
    const geometry = await shared(`ring:${key}`, () => isochrone(hub, m * 60, { direction: 'TO', mode, traffic: true }))
    remember(ringCache, key, { at: Date.now(), geometry })
    return { minutes: m, geometry }
  }))
}

interface SnapRow { vehicleId: string; name: string | null; lat: number | null; lng: number | null; speedKmh: number | null; capturedAt: string | null }

async function arrivals(orgId: string, hub: Hub, minutes: number[], mode: TravelMode, now: number): Promise<Omit<Inbound, 'rings' | 'ringsReason'>> {
  const [snap, open] = await Promise.all([getFleetSnapshotCached(orgId), getOpenTripsCached(orgId)])
  const rows = (Array.isArray(snap) ? snap : []) as unknown as SnapRow[]

  const atHub: Inbound['atHub'] = []
  const cands: (SnapRow & { lat: number; lng: number; straightM: number; run: Arrival['run']; destination: string | null })[] = []
  let leftOut = 0
  for (const r of rows) {
    if (r.lat == null || r.lng == null || !r.capturedAt) continue
    if (now - Date.parse(r.capturedAt) > FRESH_MS) continue
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
    if (straightM > FAR_M && !run) { leftOut++; continue }
    cands.push({ ...r, lat: r.lat, lng: r.lng, straightM, run, destination: trip?.destination ?? null })
  }
  // The runs bound for this hub first, then the nearest.
  cands.sort((a, b) => Number(Boolean(b.run)) - Number(Boolean(a.run)) || a.straightM - b.straightM)
  const asked = cands.slice(0, MATRIX_MAX)
  leftOut += cands.length - asked.length

  const cells = await routeMatrixTo(asked.map((c) => ({ lat: c.lat, lng: c.lng })), hub, mode)
  const computedAt = new Date(now)
  const units: Arrival[] = cells.map((cell) => {
    const c = asked[cell.index]!
    const etaS = Math.round(cell.durationS)
    const staticS = Math.round(cell.staticDurationS)
    return {
      vehicleId: c.vehicleId,
      plate: c.name,
      lat: c.lat,
      lng: c.lng,
      fixAt: c.capturedAt!,
      speedKmh: c.speedKmh,
      straightM: Math.round(c.straightM),
      distanceM: cell.distanceM,
      etaS,
      staticS,
      delayS: Math.max(0, etaS - staticS),
      arriveAt: new Date(now + etaS * 1000).toISOString(),
      withinMin: minutes.find((m) => etaS <= m * 60) ?? null,
      run: c.run,
      destination: c.destination,
    }
  }).sort((a, b) => a.etaS - b.etaS)

  return {
    enabled: true, hub, mode, minutes,
    units, atHub,
    noRoute: asked.length - cells.length,
    leftOut,
    computedAt: computedAt.toISOString(),
  }
}

export async function getInbound(
  orgId: string, hubKey: string, opts: { minutes: number[]; mode: TravelMode },
): Promise<Inbound | { enabled: false }> {
  if (!googleRoutingAvailable()) return { enabled: false }
  const hub = (await getHubs(orgId)).find((h) => h.key === hubKey)
  if (!hub) throw new NotFoundError('Hub')
  const now = Date.now()
  const minutes = [...opts.minutes].sort((a, b) => a - b)

  const mk = `${orgId}:${hub.key}:${opts.mode}:${minutes.join(',')}`
  const hit = matrixCache.get(mk)
  const [r, m] = await Promise.allSettled([
    rings(hub, minutes, opts.mode, now),
    hit && now - hit.at < MATRIX_TTL_MS
      ? Promise.resolve(hit.out)
      : shared(`matrix:${mk}`, async () => {
          const out = await arrivals(orgId, hub, minutes, opts.mode, now)
          remember(matrixCache, mk, { at: now, out })
          return out
        }),
  ])
  if (m.status === 'rejected') {
    logger.warn({ err: m.reason, hub: hub.key }, 'Arrivals: route matrix failed')
    throw new AppError(googleError(m.reason), 502)
  }
  let ringsReason: string | null = null
  if (r.status === 'rejected') {
    ringsReason = googleError(r.reason)
    logger.warn({ err: r.reason, hub: hub.key }, 'Arrivals: reverse isochrones failed')
  }
  return {
    ...m.value,
    rings: r.status === 'fulfilled' ? r.value.filter((x) => x.geometry != null) : [],
    ringsReason,
  }
}
