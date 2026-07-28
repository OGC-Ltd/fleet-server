import { findPings, findLatest, findActiveAlerts, findAlertHistoryCounts } from './telemetry.repository.js'
import { getMaintenanceHistoryCached, getOrgVehicleMaintenance } from './maintenance.cache.js'
import { getFleetSnapshotCached } from './fleet-snapshot.cache.js'
import type { TelemetryListQuery } from './telemetry.schema.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { assignedZoneStatus } from '../../lib/zone-presence.js'
import { movementState } from '../../lib/movement-state.js'
import { connectionStatus } from '../../lib/connection-state.js'

export async function listPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  const result = await findPings(vehicleId, orgId, q)
  if (!result) throw new NotFoundError('Vehicle not found')
  return result
}

export async function getFleetSnapshot(orgId: string) {
  // Warmed cache — the snapshot is each client's first paint only; the live
  // SSE stream takes over immediately after (see fleet-snapshot.cache.ts).
  const snapshot = await getFleetSnapshotCached(orgId)

  // Decorate with assigned-geofence containment.
  //
  // This CANNOT come from the SSE stream alone. Wialon only emits a frame when
  // a unit's fix time advances, so a parked vehicle may not produce one for
  // hours — and a parked vehicle is exactly the one an operator opens the card
  // to inspect. Without this, its containment badge stayed blank indefinitely
  // while moving vehicles got one within seconds.
  //
  // Free to compute: assignedZoneStatus reads the poller's in-memory presence
  // and zone caches, so this adds no query to a request that is already served
  // from a warm cache. It is deliberately applied AFTER the cache rather than
  // inside it, so containment is current even when the cached rows are a sweep
  // interval old.
  // findFleetSnapshot returns a flat ARRAY of vehicle rows (the response
  // wrapper is what adds `data`), so map it directly.
  if (!Array.isArray(snapshot)) return snapshot
  return snapshot.map(v => {
    const zones = assignedZoneStatus(orgId, v.vehicleId)
    // Current moving/resting run. `lastMovedAt` is the fallback for a vehicle
    // parked since before this process started: it emits no frames, so it is
    // absent from the in-memory tracker, but its last moving ping in the
    // database IS the moment it stopped. Without this the card showed nothing
    // for exactly the vehicles that have been resting longest.
    const row = v as { lastMovedAt?: Date | string | null; capturedAt?: Date | string | null; engineOn?: boolean }
    const fixMs = row.capturedAt
      ? (typeof row.capturedAt === 'string' ? Date.parse(row.capturedAt) : row.capturedAt.getTime())
      : null
    const movement = movementState(v.vehicleId, row.lastMovedAt, fixMs)

    // Keep the row self-consistent. The in-memory tracker is fed by the live
    // frame pipeline and can be fresher than the snapshot's newest stored row
    // — most visibly right after ignition support shipped, when a vehicle that
    // has not moved since still carries a row written before ignition was
    // read. Without this the card says "Idling" beside an ENGINE tile reading
    // "off". Only the two states that are POSITIVE evidence of a running
    // engine correct the field; 'resting' leaves it alone, because it can mean
    // either "off" or "not reported".
    const engineOn = (movement?.state === 'idling' || movement?.state === 'moving')
      ? true
      : row.engineOn

    // The provider's own connection verdict. Attached here for the same reason
    // as `zones` above — an OFFLINE unit emits no frame by definition, so this
    // can never arrive through the telemetry stream, and inferring it from the
    // age of the newest ping is measurably wrong (see lib/connection-state).
    //
    // `null` when the poller has no current answer (this process polls no
    // provider, or the sweep has stalled). Clients then fall back to the
    // last-reported window rather than being told the fleet is offline.
    const conn = connectionStatus((v as { deviceId?: string | null }).deviceId)

    return {
      ...v,
      zones,
      movement,
      engineOn,
      connectionOnline:    conn?.online    ?? null,
      connectionCheckedAt: conn?.checkedAt ?? null,
    }
  })
}

export async function getLatestPing(vehicleId: string, orgId: string) {
  const ping = await findLatest(vehicleId, orgId)
  if (ping === null && ping !== undefined) throw new NotFoundError('Vehicle not found')
  return ping
}

export async function getActiveAlerts(orgId: string) {
  return findActiveAlerts(orgId)
}

export async function getAlertHistoryCounts(orgId: string) {
  return findAlertHistoryCounts(orgId)
}

// The maintenance reads below serve from the warmed in-memory caches
// (maintenance.cache.ts) — the remote DB is never on the request path.

export async function getMaintenanceHistory(orgId: string, days?: number, to?: Date) {
  return getMaintenanceHistoryCached(orgId, days ?? 14, to)
}

export async function getVehicleServiceHistory(orgId: string, vehicleId: string) {
  const maint = await getOrgVehicleMaintenance(orgId)
  if (!maint.vehicleIds.includes(vehicleId)) throw new NotFoundError('Vehicle not found')
  return maint.services[vehicleId] ?? []
}

export async function getVehicleGarageVisits(orgId: string, vehicleId: string) {
  const maint = await getOrgVehicleMaintenance(orgId)
  if (!maint.vehicleIds.includes(vehicleId)) throw new NotFoundError('Vehicle not found')
  return maint.visits[vehicleId] ?? []
}
