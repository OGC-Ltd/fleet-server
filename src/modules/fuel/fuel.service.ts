import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './fuel.repository.js'
import { emitDashboardFuelIncidentDismissed } from '../../lib/sse.js'
import { forgetSnapshotIncident } from '../telemetry/fleet-snapshot.cache.js'
import { followUpOpened } from './fuel-followup.service.js'
import { logger } from '../../lib/logger.js'
import type { CreateFillingDto, ListFillingQuery, CreateTheftDto, ListTheftQuery, TheftOutcomesQuery } from './fuel.schema.js'

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
 * What reviewers concluded about the fleet's fuel alerts over a window — see
 * FuelTheft.reviewStatus. `unreviewed` is every alert nobody deleted: it
 * stands as the detector reported it.
 */
export async function theftOutcomes(orgId: string, q: TheftOutcomesQuery) {
  const rows = await repo.theftOutcomeRows(orgId, q.from, q.to)
  const byStatus = new Map<string, { count: number; litres: number }>()
  const confirmedByVehicle = new Map<string, { vehicleId: string; plate: string; count: number; litres: number }>()
  const hoursToDecision: number[] = []
  for (const r of rows) {
    const key = r.reviewStatus ?? 'unreviewed'
    const s = byStatus.get(key) ?? { count: 0, litres: 0 }
    s.count++; s.litres += r.stolenMl / 1000
    byStatus.set(key, s)
    if (r.reviewStatus === 'CONFIRMED_THEFT') {
      const v = confirmedByVehicle.get(r.vehicleId) ?? { vehicleId: r.vehicleId, plate: r.vehicle.registrationPlate, count: 0, litres: 0 }
      v.count++; v.litres += r.stolenMl / 1000
      confirmedByVehicle.set(r.vehicleId, v)
    }
    if ((r.reviewStatus === 'CONFIRMED_THEFT' || r.reviewStatus === 'NOT_THEFT') && r.dismissedAt && r.reviewedAt) {
      hoursToDecision.push((r.reviewedAt.getTime() - r.dismissedAt.getTime()) / 3_600_000)
    }
  }
  const round = (n: number) => Math.round(n * 10) / 10
  hoursToDecision.sort((a, b) => a - b)
  return {
    from: q.from ?? null,
    to: q.to ?? null,
    total: rows.length,
    byStatus: Object.fromEntries(
      ['unreviewed', 'DISMISSED', 'UNDER_REVIEW', 'CONFIRMED_THEFT', 'NOT_THEFT'].map((k) => {
        const s = byStatus.get(k) ?? { count: 0, litres: 0 }
        return [k, { count: s.count, litres: round(s.litres) }]
      }),
    ),
    confirmedByVehicle: [...confirmedByVehicle.values()]
      .map((v) => ({ ...v, litres: round(v.litres) }))
      .sort((a, b) => b.litres - a.litres),
    /** Median hours from deletion to escalation or de-escalation. */
    medianHoursToDecision: hoursToDecision.length
      ? round(hoursToDecision[Math.floor(hoursToDecision.length / 2)])
      : null,
  }
}

/**
 * Take a fuel incident off the dashboard for the whole organisation, keeping
 * the record. See FuelTheft.dismissedAt.
 *
 * The cached snapshot is patched straight away so a page load a second later
 * does not bring the incident back until the next rebuild, and every open
 * dashboard is told over SSE so it drops the incident without reloading.
 *
 * The first dismissal also opens a follow-up that someone else must accept —
 * see fuel-followup.service. Its announcement is detached: the dismissal and
 * the follow-up are already stored, and a feed hiccup must not fail them.
 */
export async function dismissTheft(orgId: string, id: string, userId: string | null) {
  const row = await repo.dismissTheft(orgId, id, userId)
  if (!row) throw new NotFoundError('Fuel theft')
  forgetSnapshotIncident(orgId, id)
  emitDashboardFuelIncidentDismissed(orgId, { vehicleId: row.vehicleId, incidentId: id })
  if (row.followUpId) {
    void followUpOpened(orgId, row.followUpId)
      .catch((err) => logger.warn({ err, followUpId: row.followUpId }, 'Fuel follow-up: announcement failed'))
  }
  return { id: row.id, dismissedAt: row.dismissedAt, followUpId: row.followUpId }
}
