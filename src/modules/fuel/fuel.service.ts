import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors/errors.js'
import * as repo from './fuel.repository.js'
import { emitDashboardFuelIncidentDismissed } from '../../lib/sse.js'
import { forgetSnapshotIncident, patchSnapshotIncidentReview } from '../telemetry/fleet-snapshot.cache.js'
import { followUpOpened } from './fuel-followup.service.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { publishNotification } from '../../lib/notifications/notification.store.js'
// Who decides a live alert is who assigns a follow-up: the organisation's
// administrator or the platform administrator (repairs.authz). One rule.
import { canAssignTriage } from '../repairs/repairs.authz.js'
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

/** May this account escalate or de-escalate a live alert here? */
export async function canReviewTheft(orgId: string, userId: string | null) {
  return userId != null && (await canAssignTriage(userId, orgId)).ok
}

/**
 * Escalate (a confirmed theft) or de-escalate (not a theft) a live alert, from
 * its window, without deleting it. Administrators only. The alert stays on the
 * dashboard either way, now carrying the decision; see repo.reviewTheft.
 */
export async function reviewTheft(
  orgId: string, id: string, userId: string,
  outcome: 'ESCALATED' | 'DEESCALATED', note: string,
) {
  const check = await canAssignTriage(userId, orgId)
  if (!check.ok) {
    throw new ForbiddenError(check.reason === 'not_a_member'
      ? 'Only an administrator of this organisation can escalate or de-escalate a fuel alert'
      : 'Only a system administrator or the platform administrator can escalate or de-escalate a fuel alert')
  }
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true } })
  const reviewer = me?.email ?? me?.fullName ?? userId
  const row = await repo.reviewTheft({ orgId, id, userId, reviewer, outcome, note })
  if (!row) throw new NotFoundError('Fuel theft')
  if (row === 'dismissed') {
    throw new ConflictError('This alert was deleted, so it has a Case: escalate or de-escalate it there')
  }

  const review = {
    status: row.reviewStatus ?? (outcome === 'ESCALATED' ? 'CONFIRMED_THEFT' : 'NOT_THEFT'),
    at: row.reviewedAt?.toISOString() ?? null,
    by: row.reviewedBy?.fullName ?? null,
    note: row.reviewNote,
  }
  patchSnapshotIncidentReview(orgId, id, review)

  const who = review.by ?? 'An administrator'
  const incident = `${row.vehicle.registrationPlate} fuel incident (${(row.stolenMl / 1000).toFixed(1)} L)`
  try {
    publishNotification({
      orgId,
      id: `theft-${id}-${outcome.toLowerCase()}-${Date.now()}`,
      source: 'fuel-review',
      alertType: `FUEL_ALERT_${outcome}`,
      severity: outcome === 'ESCALATED' ? 'critical' : 'info',
      text: outcome === 'ESCALATED'
        ? `CONFIRMED FUEL THEFT: ${who} escalated the ${incident}.`
        : `NOT A THEFT: ${who} de-escalated the ${incident}.`,
      at: new Date(),
      plate: row.vehicle.registrationPlate,
      vehicleId: row.vehicleId,
      extra: { incidentId: id },
    })
  } catch (err) {
    logger.warn({ err, theftId: id }, 'Fuel review: feed publish failed')
  }
  return { id, review }
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
  // The clicked incident and every other one on the unit it swept along.
  for (const incidentId of [id, ...row.dismissedIds]) {
    forgetSnapshotIncident(orgId, incidentId)
    emitDashboardFuelIncidentDismissed(orgId, { vehicleId: row.vehicleId, incidentId })
  }
  if (row.followUpId) {
    void followUpOpened(orgId, row.followUpId)
      .catch((err) => logger.warn({ err, followUpId: row.followUpId }, 'Fuel follow-up: announcement failed'))
  }
  return { id: row.id, dismissedAt: row.dismissedAt, followUpId: row.followUpId }
}
