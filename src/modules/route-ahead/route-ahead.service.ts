/**
 * The road ahead of a tracked unit, and how far it can get.
 *
 * Both start from the unit's latest Wialon fix — the same position the map
 * draws — so there is no phone and no driver in the loop.
 *
 * ## Where it is going
 *
 * In order: a point the operator picked (query string), else the unit's open
 * dispatch. A dispatch whose destination the unit has already been seen at is
 * on its way BACK, so the route then runs to the gate it left from — the same
 * rule the trip card uses (dispatch-trip `returning`). A unit with neither has
 * nothing to route to and says so instead of guessing.
 *
 * ## Cost
 *
 * Every computeRoutes and isochrone call is billed. A tracked map re-asks on
 * every fix, so answers are cached: a route is reused while the unit has moved
 * less than ROUTE_REUSE_M and is younger than ROUTE_MAX_AGE_MS, and is never
 * re-fetched more often than ROUTE_MIN_AGE_MS; a reach ring is reused for
 * anything within ~100 m of the same spot for REACH_TTL_MS. Concurrent asks for
 * the same answer share one request.
 */

import { AppError } from '../../core/errors/AppError.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { haversineM, type Point } from '../../lib/dispatch-trip.js'
import { logger } from '../../lib/logger.js'
import { findLatest } from '../telemetry/telemetry.repository.js'
import { getOpenTripsCached } from '../dispatches/open-trips.cache.js'
import {
  computeRoute, isochrone, googleRoutingAvailable, GoogleRoutingError,
  type RoadRoute,
} from '../../providers/google-routing/index.js'

export const ROUTE_MIN_AGE_MS = 30_000
export const ROUTE_MAX_AGE_MS = 3 * 60_000
export const ROUTE_REUSE_M = 250
export const REACH_TTL_MS = 10 * 60_000
/** Within this of the destination the unit is there; no route is asked for. */
export const ARRIVED_M = 300
export const REACH_MINUTES = [15, 30, 60] as const

export interface Destination extends Point {
  name: string | null
  /** custom = picked on the map; dispatch = the run's destination; return = back to the gate. */
  source: 'custom' | 'dispatch' | 'return'
}

export interface RouteAhead {
  enabled: true
  origin: (Point & { fixAt: string }) | null
  destination: Destination | null
  route: RoadRoute | null
  /** When it should arrive, from `computedAt` + the traffic-aware duration. */
  etaAt: string | null
  computedAt: string | null
  arrived: boolean
  /** Why there is no route, in words a card can show. */
  reason: string | null
}

// ── caches ──────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 2_000

interface RouteEntry { destKey: string; origin: Point; at: number; route: RoadRoute | null }
const routes = new Map<string, RouteEntry>()
const reach = new Map<string, { at: number; geometry: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

function remember<K, V>(m: Map<K, V>, k: K, v: V) {
  m.delete(k)
  m.set(k, v)
  if (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as K)
}

function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key)
  if (hit) return hit as Promise<T>
  const p = run().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

const destKeyOf = (d: Point) => `${d.lat.toFixed(5)},${d.lng.toFixed(5)}`

/** May a cached route stand in for one from `origin` now? Exported for tests. */
export function routeReusable(e: RouteEntry | undefined, destKey: string, origin: Point, now: number): boolean {
  if (!e || e.destKey !== destKey) return false
  const age = now - e.at
  if (age < ROUTE_MIN_AGE_MS) return true
  return age < ROUTE_MAX_AGE_MS && haversineM(e.origin, origin) < ROUTE_REUSE_M
}

function googleError(err: unknown): never {
  if (err instanceof GoogleRoutingError) {
    logger.warn({ status: err.status, msg: err.message }, 'google routing refused')
    throw new AppError(`Google: ${err.message}`, 502)
  }
  if ((err as Error)?.name === 'TimeoutError') throw new AppError('Google did not answer in time', 504)
  throw err
}

// ── where it is ─────────────────────────────────────────────────────────────

async function latestFix(orgId: string, vehicleId: string): Promise<(Point & { fixAt: string }) | null> {
  const ping = await findLatest(vehicleId, orgId)
  if (ping === null) throw new NotFoundError('Vehicle')
  if (ping?.lat == null || ping.lng == null) return null
  return { lat: ping.lat, lng: ping.lng, fixAt: ping.capturedAt.toISOString() }
}

/** The open dispatch's far end, or the gate on the way back. */
async function dispatchDestination(orgId: string, vehicleId: string): Promise<Destination | null> {
  const { yard, yardName, byVehicle } = await getOpenTripsCached(orgId)
  const trip = byVehicle.get(vehicleId)
  if (!trip) return null
  if (trip.arrivedAt != null) {
    const lat = trip.originLat ?? yard?.lat
    const lng = trip.originLng ?? yard?.lng
    if (lat == null || lng == null) return null
    return { lat, lng, name: trip.originName ?? yardName, source: 'return' }
  }
  if (trip.destinationLat == null || trip.destinationLng == null) return null
  return { lat: trip.destinationLat, lng: trip.destinationLng, name: trip.destination, source: 'dispatch' }
}

// ── the two answers ─────────────────────────────────────────────────────────

export async function getRouteAhead(
  orgId: string,
  vehicleId: string,
  custom: Destination | null,
): Promise<RouteAhead | { enabled: false }> {
  if (!googleRoutingAvailable()) return { enabled: false }

  const [origin, destination] = await Promise.all([
    latestFix(orgId, vehicleId),
    custom ? Promise.resolve(custom) : dispatchDestination(orgId, vehicleId),
  ])
  const none = (reason: string, arrived = false): RouteAhead => ({
    enabled: true, origin, destination, route: null, etaAt: null, computedAt: null, arrived, reason,
  })

  if (!origin) return none('This unit has no position yet.')
  if (!destination) return none('No destination: this unit is not on a dispatch. Pick one on the map.')
  if (haversineM(origin, destination) < ARRIVED_M) return none('At the destination.', true)

  const destKey = destKeyOf(destination)
  const now = Date.now()
  let entry = routes.get(vehicleId)
  if (!routeReusable(entry, destKey, origin, now)) {
    const route = await shared(`route:${vehicleId}:${destKey}`, () =>
      computeRoute(origin, destination).catch(googleError))
    entry = { destKey, origin: { lat: origin.lat, lng: origin.lng }, at: Date.now(), route }
    remember(routes, vehicleId, entry)
  }
  const e = entry as RouteEntry
  if (!e.route) return none('Google found no road route to this destination.')
  return {
    enabled: true,
    origin,
    destination,
    route: e.route,
    etaAt: new Date(e.at + e.route.durationS * 1000).toISOString(),
    computedAt: new Date(e.at).toISOString(),
    arrived: false,
    reason: null,
  }
}

export interface ReachRing { minutes: number; geometry: unknown }

export async function getReach(
  orgId: string,
  vehicleId: string,
  minutes: number[],
): Promise<{ enabled: false } | { enabled: true; origin: (Point & { fixAt: string }) | null; rings: ReachRing[] }> {
  if (!googleRoutingAvailable()) return { enabled: false }
  const origin = await latestFix(orgId, vehicleId)
  if (!origin) return { enabled: true, origin, rings: [] }

  // ~100 m grid: a parked unit's GPS jitter must not buy a new polygon.
  const spot = `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`
  const rings = await Promise.all(minutes.map(async (m) => {
    const key = `${spot}:${m}`
    const hit = reach.get(key)
    if (hit && Date.now() - hit.at < REACH_TTL_MS) return { minutes: m, geometry: hit.geometry }
    const geometry = await shared(`reach:${key}`, () => isochrone(origin, m * 60).catch(googleError))
    remember(reach, key, { at: Date.now(), geometry })
    return { minutes: m, geometry }
  }))
  return { enabled: true, origin, rings }
}

/** Tests only. */
export function _resetRouteAheadCaches() {
  routes.clear()
  reach.clear()
  inflight.clear()
}
