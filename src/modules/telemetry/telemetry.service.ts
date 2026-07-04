import { findPings, findLatest, findFleetSnapshot, findActiveAlerts, findAlertHistoryCounts, findMaintenanceHistory, findVehicleServiceHistory, findVehicleGarageVisits } from './telemetry.repository.js'
import type { TelemetryListQuery } from './telemetry.schema.js'
import { NotFoundError } from '../../core/errors/errors.js'

export async function listPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  const result = await findPings(vehicleId, orgId, q)
  if (!result) throw new NotFoundError('Vehicle not found')
  return result
}

export async function getFleetSnapshot(orgId: string) {
  return findFleetSnapshot(orgId)
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

export async function getMaintenanceHistory(orgId: string, days?: number, to?: Date) {
  return findMaintenanceHistory(orgId, days, to)
}

export async function getVehicleServiceHistory(orgId: string, vehicleId: string) {
  const history = await findVehicleServiceHistory(orgId, vehicleId)
  if (!history) throw new NotFoundError('Vehicle not found')
  return history
}

export async function getVehicleGarageVisits(orgId: string, vehicleId: string) {
  const visits = await findVehicleGarageVisits(orgId, vehicleId)
  if (!visits) throw new NotFoundError('Vehicle not found')
  return visits
}
