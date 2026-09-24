import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './fuel.repository.js'
import { emitDashboardFuelIncidentDismissed } from '../../lib/sse.js'
import { forgetSnapshotIncident } from '../telemetry/fleet-snapshot.cache.js'
import type { CreateFillingDto, ListFillingQuery, CreateTheftDto, ListTheftQuery } from './fuel.schema.js'

export const listFillings = (orgId: string, q: ListFillingQuery) => repo.findAllFillings(orgId, q)

export async function getFilling(orgId: string, id: string) {
  const item = await repo.findFillingById(orgId, id)
  if (!item) throw new NotFoundError('Fuel filling')
  return item
}

export const createFilling = (dto: CreateFillingDto) => repo.createFilling(dto)

export const listThefts = (orgId: string, q: ListTheftQuery) => repo.findAllThefts(orgId, q)

export async function getTheft(orgId: string, id: string) {
  const item = await repo.findTheftById(orgId, id)
  if (!item) throw new NotFoundError('Fuel theft')
  return item
}

export const createTheft = (dto: CreateTheftDto) => repo.createTheft(dto)

/**
 * Take a fuel incident off the dashboard for the whole organisation, keeping
 * the record. See FuelTheft.dismissedAt.
 *
 * The cached snapshot is patched straight away so a page load a second later
 * does not bring the incident back until the next rebuild, and every open
 * dashboard is told over SSE so it drops the incident without reloading.
 */
export async function dismissTheft(orgId: string, id: string, userId: string | null) {
  const row = await repo.dismissTheft(orgId, id, userId)
  if (!row) throw new NotFoundError('Fuel theft')
  forgetSnapshotIncident(orgId, id)
  emitDashboardFuelIncidentDismissed(orgId, { vehicleId: row.vehicleId, incidentId: id })
  return { id: row.id, dismissedAt: row.dismissedAt }
}
