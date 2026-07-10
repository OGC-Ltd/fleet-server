/**
 * Dashboard summary — aggregates the three header KPIs from live fleet data:
 *   1. storage    — sugar in silos (Silo table)
 *   2. inTransit  — vehicles currently moving + tonnes of sugar aboard
 *   3. sensors    — per-sensor-type configured vs. operational across the fleet
 *
 * inTransit + sensors derive from `findLatestPerVehicle` (one round-trip for the
 * whole fleet), so the endpoint stays fast even polled every 30 s.
 */

import { findSilos, findLatestPerVehicle } from './dashboard.repository.js'
import type { FleetRow } from './dashboard.repository.js'
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
