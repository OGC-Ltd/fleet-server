import { findPings, findLatest, findActiveAlerts, findAlertHistoryCounts } from './telemetry.repository.js'
import { getMaintenanceHistoryCached, getOrgVehicleMaintenance } from './maintenance.cache.js'
import { getFleetSnapshotCached } from './fleet-snapshot.cache.js'
import type { TelemetryListQuery } from './telemetry.schema.js'
import { NotFoundError } from '../../core/errors/errors.js'

export async function listPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  const result = await findPings(vehicleId, orgId, q)
  if (!result) throw new NotFoundError('Vehicle not found')
  return result
}

export async function getFleetSnapshot(orgId: string) {
  // Warmed cache — the snapshot is each client's first paint only; the live
  // SSE stream takes over immediately after (see fleet-snapshot.cache.ts).
  return getFleetSnapshotCached(orgId)
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
