/**
 * West Kenya's stop watch rules (operator, 2026-11-19: alerts "whenever the
 * West Kenya trucks and prime movers stop for more than five minutes when they
 * are not on site or weighbridges").
 *
 * Its three organisations on our side (West Kenya, Kabras, Nzoia, split from one
 * Wialon resource in Oct 2026) are watched alike. Only trucks and prime movers
 * (reports/vehicle-kind isTruck, the TAT report's own test). A stop counts once
 * the unit has stood WK_STOP_MS; it is fine inside a factory, yard or works
 * fence, or a weighbridge (WK_ALLOWED, the geofence categories of
 * lib/zone-taxonomy), of any of the three organisations: a Kabras lorry weighed
 * on a West Kenya bridge is on site. Everywhere else it is an unauthorised stop.
 *
 * Pure: no database, no network (stop-watch.service runs it).
 */
import { isTruck } from '../reports/vehicle-kind.js'
import { STALE_MS, placeAt, plateIn, type Place, type SnapshotUnit, type StopFlag } from './stop-watch.rules.js'

export const WK_ORGS = ['WESTSUGAR', 'KABRAS', 'NZOIA'] as const
export const WK_STOP_MS = 5 * 60_000
/** Where a stop is on site: factories, yards and depots, works perimeters, weighbridges. */
export const WK_ALLOWED: ReadonlySet<string> = new Set(['factory', 'logistics', 'perimeter', 'weighing'])
const STAND_KMH = 3

/** A snapshot unit with its type, for the truck test. */
export interface WkUnit extends SnapshotUnit { vehicleType?: string | null }

/** The trucks and prime movers stopped WK_STOP_MS or more off site, most recent first. */
export function westKenyaStops(units: readonly WkUnit[], allowed: readonly Place[], now = Date.now()): StopFlag[] {
  const out: StopFlag[] = []
  for (const v of units) {
    if (!isTruck({ type: v.vehicleType ?? 'UNSPECIFIED', plate: v.plate ?? '', name: v.name ?? '' })) continue
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue
    const lat = v.lat as number
    const lng = v.lng as number
    const seen = v.capturedAt ? Date.parse(v.capturedAt) : NaN
    if (Number.isFinite(seen) && now - seen > STALE_MS) continue
    if (v.movement?.state === 'moving' || Math.round(v.speedKmh ?? 0) >= STAND_KMH) continue
    const since = Date.parse(v.movement?.since ?? '')
    if (!Number.isFinite(since) || now - since < WK_STOP_MS) continue
    if (placeAt(lat, lng, allowed)) continue
    out.push({
      key: `${v.vehicleId}|wkstop|${since}`, vehicleId: v.vehicleId,
      plate: plateIn(v.plate, v.name) ?? v.plate ?? v.vehicleId, name: v.name ?? null,
      kind: 'unauthorised', zone: null, since, lat, lng,
    })
  }
  return out.sort((a, b) => b.since - a.since)
}
