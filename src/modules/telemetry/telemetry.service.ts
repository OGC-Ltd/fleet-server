import { findPings, findLatest } from './telemetry.repository.js'
import type { TelemetryListQuery } from './telemetry.schema.js'
import { NotFoundError } from '../../core/errors/errors.js'

export async function listPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  const result = await findPings(vehicleId, orgId, q)
  if (!result) throw new NotFoundError('Vehicle not found')
  return result
}

export async function getLatestPing(vehicleId: string, orgId: string) {
  const ping = await findLatest(vehicleId, orgId)
  if (ping === null && ping !== undefined) throw new NotFoundError('Vehicle not found')
  return ping
}
