/**
 * Dashboard summary — aggregates the three header KPIs from live fleet data:
 *   1. storage    — sugar in silos (Silo table)
 *   2. inTransit  — vehicles currently moving + tonnes of sugar aboard
 *   3. sensors    — per-sensor-type configured vs. operational across the fleet
 *
 * inTransit + sensors derive from `findLatestPerVehicle` (one round-trip for the
 * whole fleet), so the endpoint stays fast even polled every 30 s.
 */

import { findSilos, findLatestPerVehicle, findFleetPulseRows } from './dashboard.repository.js'
import { connectionStatus } from '../../lib/connection-state.js'
import { MOVING_THRESHOLD_KMH } from '../../lib/movement-state.js'
import type { FleetRow, PulseRow } from './dashboard.repository.js'
import { createWarmCache } from '../../lib/warm-cache.js'

// Sugar-logistics carriers: tractors haul raw cane, lorries/canters processed sugar.
const SUGAR_CARRIERS = new Set(['TRACTOR', 'TRUCK', 'LORRY', 'LORRY & TRAILER', 'CANTER'])
// Vehicle types fitted with a load-cell (LOAD sensor applies to these only).
const CARGO_CAPABLE  = new Set(['TRACTOR', 'TRUCK', 'LORRY', 'LORRY & TRAILER', 'CANTER', 'TANKER', 'TIPPER', 'PICKUP', 'VAN', 'FLATBED', 'REFRIGERATED', 'CARGO VAN'])
// A sensor is "operational" only if its vehicle produced a fresh ping (~3 poll cycles).
const FRESH_MS = 300_000
const LOW_FUEL_RATIO = 0.20
const SENSOR_TYPES = ['GPS', 'FUEL', 'LOAD', 'SPEED', 'ENGINE'] as const

const round = (n: number, dp = 0) => { const f = 10 ** dp; return Math.round(n * f) / f }

function deriveCargo(vehicleType: string, kg: number | null): string {
  const loaded = kg != null && kg > 0
  if (vehicleType === 'TRACTOR')                       return loaded ? 'Raw Sugar Cane'  : 'Empty (en route to farm)'
  if (SUGAR_CARRIERS.has(vehicleType))                 return loaded ? 'Processed Sugar' : 'Empty (returning to depot)'
  return loaded ? 'General Cargo' : 'Empty'
}

function isLowFuel(v: FleetRow): boolean {
  if (v.fuelLevelMl == null) return false
  const tankMl = (v.tankCapacityLitres ?? 200) * 1000
  return v.fuelLevelMl < tankMl * LOW_FUEL_RATIO
}

function chipStatus(v: FleetRow): 'ok' | 'warning' | 'critical' {
  if (isLowFuel(v))            return 'critical'
  if ((v.speedKmh ?? 0) > 80)  return 'warning'
  return 'ok'
}

// Warmed cache (lib/warm-cache.ts) — the old 10s TTL cache still BLOCKED the
// request on the ~0.7s recompute whenever it expired, so most 30s header polls
// paid the remote-DB round trip. Now requests always return from memory and
// the warmer keeps every org fresh in the background; the header's inTransit
// figure is overridden live from the SSE stream client-side anyway, and the
// 5-min sensor-freshness window dwarfs the sweep interval.
const summaryCache = createWarmCache<Awaited<ReturnType<typeof computeDashboardSummary>>>({
  name: 'dashboard-summary',
  compute: (orgId) => computeDashboardSummary(orgId),
  warmKeysFor: (orgId) => [orgId],
})

/**
 * The platform's live pulse — total units, and how many are moving.
 *
 * Served to callers with NO SESSION, which is the fact that shapes everything
 * about it:
 *
 *   · It is two integers and a timestamp. No organisation is named, no vehicle
 *     is identified, nothing here can be attributed to a customer. `/bootstrap`
 *     on this server used to be open and returned every tenant's id and code;
 *     it is authenticated now, and this route exists on the understanding that
 *     it must never grow into that.
 *
 *   · It is cached for a fixed window and every caller shares the cache. An
 *     unauthenticated endpoint that ran a lateral join over every vehicle in
 *     the platform per request is a database outage anybody could trigger with
 *     a for-loop. Polling it a thousand times a second costs one query a
 *     minute; the rate limiter is then only a courtesy rather than the thing
 *     standing between this and the fleet.
 *
 *   · The cached value is served STALE on a failure rather than surfacing an
 *     error, and an empty platform reports zero rather than throwing. Nobody
 *     should be unable to reach a sign-in form because a count did not come
 *     back.
 *
 * The window is 30s. Shorter buys nothing — the pollers write telemetry on a
 * slower cycle than that, so a fresher cache would return the same numbers
 * having asked again.
 */
const PULSE_TTL_MS = 30_000

type FleetPulse = { total: number; inTransit: number; share: number; asOf: string }
let pulseCache: { value: FleetPulse; at: number } | null = null
let pulseInFlight: Promise<FleetPulse> | null = null

/**
 * How many of these units are in transit RIGHT NOW.
 *
 * This is the dashboard's own test, applied to the whole platform, and it has
 * to stay that way — the sign-in screen and the header say "units in transit"
 * and must mean one thing by it. The dash's `isInTransit` (lib/vehicleMap) is
 * the definition being mirrored:
 *
 *     connectionOnline === true  AND  engine on  AND  round(speed) >= 1
 *
 * Two of those three were previously approximated here and both approximations
 * inflated the number.
 *
 * CONNECTION was a five-minute freshness window on the newest ping. That is a
 * different question with a similar shape: "sent a message recently" is not "is
 * connected" — a unit can post a queued frame and be gone, and a tracker
 * configured to report every thirty minutes is not offline at minute six.
 * Measured on the live Kasulu account, a window disagreed with Wialon's own
 * verdict on 28 of 224 units, 25 of them units Wialon called offline. Those 25
 * were counted here and not on the dashboard.
 *
 * SPEED was `> 0` against the dash's `>= 1` on the ROUNDED value, so anything
 * drifting between 0 and 0.5 km/h counted here and nowhere else.
 *
 * Consequence worth knowing, and it is the honest one: where the poller is not
 * running, no unit has a connection verdict, so this reports zero in transit —
 * exactly as the dashboard reports the whole fleet offline in that state. A
 * figure that disagreed with the dashboard in order to look busier would be
 * worse than a zero that matches it.
 */
export function countPulse(rows: PulseRow[]): { total: number; inTransit: number } {
  let inTransit = 0
  for (const r of rows) {
    if (!r.engineOn) continue
    if (Math.round(r.speedKmh ?? 0) < MOVING_THRESHOLD_KMH) continue
    if (connectionStatus(r.deviceId)?.online !== true) continue
    inTransit++
  }
  return { total: rows.length, inTransit }
}

export async function getFleetPulse(): Promise<FleetPulse> {
  const now = Date.now()
  if (pulseCache && now - pulseCache.at < PULSE_TTL_MS) return pulseCache.value
  // One recompute at a time. Without this, the first request after the window
  // expires is joined by every other request that arrives while it runs, and
  // each of them starts its own copy of the same query.
  if (pulseInFlight) return pulseInFlight

  pulseInFlight = (async () => {
    try {
      const { total, inTransit } = countPulse(await findFleetPulseRows())
      const value: FleetPulse = {
        total,
        inTransit,
        share: total > 0 ? round((inTransit / total) * 100) : 0,
        asOf: new Date().toISOString(),
      }
      pulseCache = { value, at: Date.now() }
      return value
    } catch (err) {
      // Stale beats an error on a page whose job is to show a sign-in form.
      if (pulseCache) return pulseCache.value
      throw err
    } finally {
      pulseInFlight = null
    }
  })()

  return pulseInFlight
}

export async function getDashboardSummary(orgId: string) {
  return summaryCache.get(orgId)
}

async function computeDashboardSummary(orgId: string) {
  const [silos, fleet] = await Promise.all([findSilos(orgId), findLatestPerVehicle(orgId)])
  const now = Date.now()

  // ── 1. Sugar in storage ──────────────────────────────────────────────────
  const storage = {
    totalTonnes: round(silos.reduce((a, s) => a + s.storedTonnes, 0)),
    siloCount:   silos.length,
    silos: silos.map(s => ({
      id:             s.id,
      code:           s.code,
      name:           s.name,
      locationName:   s.locationName,
      capacityTonnes: s.capacityTonnes,
      storedTonnes:   s.storedTonnes,
      fillPct:        s.capacityTonnes > 0 ? round((s.storedTonnes / s.capacityTonnes) * 100) : 0,
      sugarType:      s.sugarType,
      status:         s.status,
    })),
  }

  // ── 2. Vehicles in transit + sugar transported ───────────────────────────
  const inTransitVehicles = fleet.filter(v => v.engineOn && (v.speedKmh ?? 0) > 0)
  const sugarTonnes = round(
    inTransitVehicles
      .filter(v => SUGAR_CARRIERS.has(v.vehicleType) && (v.cargoWeightKg ?? 0) > 0)
      .reduce((a, v) => a + (v.cargoWeightKg as number) / 1000, 0),
    1,
  )
  const inTransit = {
    vehicleCount: inTransitVehicles.length,
    sugarTonnes,
    vehicles: inTransitVehicles
      .map(v => ({
        vehicleId:   v.vehicleId,
        plate:       v.plate,
        driver:      v.driver ?? 'Unassigned',
        vehicleType: v.vehicleType,
        cargo:       deriveCargo(v.vehicleType, v.cargoWeightKg),
        tonnes:      v.cargoWeightKg != null ? round(v.cargoWeightKg / 1000, 1) : 0,
        status:      chipStatus(v),
      }))
      .sort((a, b) => b.tonnes - a.tonnes),
  }

  // ── 3. Sensors configured vs. operational (per type, across the fleet) ────
  const byType: Record<string, { configured: number; operational: number }> =
    Object.fromEntries(SENSOR_TYPES.map(t => [t, { configured: 0, operational: 0 }]))

  const vehiclesSensors = fleet.map(v => {
    const fresh        = v.capturedAt != null && (now - new Date(v.capturedAt).getTime()) < FRESH_MS
    const cargoCapable = CARGO_CAPABLE.has(v.vehicleType)
    const defs: { type: string; applicable: boolean; present: boolean }[] = [
      { type: 'GPS',    applicable: true,         present: v.lat != null && v.lng != null },
      { type: 'FUEL',   applicable: true,         present: v.fuelLevelMl != null },
      { type: 'SPEED',  applicable: true,         present: v.speedKmh != null },
      { type: 'ENGINE', applicable: true,         present: true }, // engineOn is always reported
      { type: 'LOAD',   applicable: cargoCapable, present: v.cargoWeightKg != null },
    ]
    const sensors = defs
      .filter(d => d.applicable)
      .map(d => {
        const operational = fresh && d.present
        const bucket = byType[d.type]!
        bucket.configured++
        if (operational) bucket.operational++
        return { type: d.type, status: operational ? 'operational' : 'offline' }
      })
    return { vehicleId: v.vehicleId, plate: v.plate, sensors }
  })

  const sensors = {
    configured:  Object.values(byType).reduce((a, t) => a + t.configured, 0),
    operational: Object.values(byType).reduce((a, t) => a + t.operational, 0),
    byType:      SENSOR_TYPES.map(t => ({ type: t, ...byType[t]! })),
    vehicles:    vehiclesSensors,
  }

  return { storage, inTransit, sensors }
}
