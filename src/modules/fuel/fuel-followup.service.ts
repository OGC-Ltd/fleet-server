/**
 * The follow-up a dismissed fuel incident opens — see FuelTheftFollowUp.
 *
 *   dismiss ─▶ OPEN ─accept─▶ ACCEPTED ─escalate───▶ ESCALATED   (confirmed theft)
 *                                     └─de-escalate─▶ DEESCALATED (not a theft)
 *
 * Who may do what:
 *   - accept:    anyone holding `fuel_theft:triage` (checked on the route),
 *                EXCEPT the account that deleted the alert.
 *   - note, escalate, de-escalate: only the account that accepted it.
 *
 * Every step is logged with its actor and mirrored onto the alert itself
 * (FuelTheft.reviewStatus), so the incident record always says where it stands.
 *
 * Every step is announced too: the
 * opening and both outcomes go to the Live Feed, and every change goes to open
 * dashboards over SSE (`fuel_followup`) so the list updates without a reload.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { emitDashboardFuelFollowUp } from '../../lib/sse.js'
import { publishNotification } from '../../lib/notifications/notification.store.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors/errors.js'
import * as repo from './fuel-followup.repository.js'
import type { FollowUpRow } from './fuel-followup.repository.js'
import type { ListFollowUpQuery } from './fuel.schema.js'

const litres = (ml: number) => `${(ml / 1000).toFixed(1)} L`

/** The follow-up as the dashboard reads it, with what THIS viewer may do. */
export function toDto(row: FollowUpRow, viewerId: string | null) {
  const t = row.theft
  return {
    id: row.id,
    status: row.status,
    openedAt: row.openedAt,
    acceptedAt: row.acceptedAt,
    resolvedAt: row.resolvedAt,
    dismissedBy: row.dismissedBy,
    acceptedBy: row.acceptedBy,
    incident: {
      id: t.id,
      vehicleId: t.vehicleId,
      plate: t.vehicle.registrationPlate,
      volumeMl: t.stolenMl,
      beganAt: t.beganAt,
      detectedAt: t.detectedAt,
      cause: t.drainCause,
      location: t.initialLocation,
    },
    actions: row.actions,
    // Computed here so the rule lives in one place. The permission half
    // (`fuel_theft:triage`) is the client's to know; these are the parts only
    // the server can say.
    viewer: {
      deletedIt: viewerId != null && row.dismissedById === viewerId,
      ownsIt:    viewerId != null && row.acceptedById === viewerId,
    },
  }
}

export async function listFollowUps(orgId: string, q: ListFollowUpQuery, viewerId: string | null) {
  const rows = await repo.listFollowUps(orgId, repo.STATUS_FILTER[q.status], q.limit)
  return rows.map((r) => toDto(r, viewerId))
}

async function load(orgId: string, id: string) {
  const row = await repo.findFollowUp(orgId, id)
  if (!row) throw new NotFoundError('Fuel follow-up')
  return row
}

export async function getFollowUp(orgId: string, id: string, viewerId: string | null) {
  return toDto(await load(orgId, id), viewerId)
}

/** Re-read after a change, tell every dashboard, and hand the new state back. */
async function changed(orgId: string, id: string) {
  const row = await load(orgId, id)
  emitDashboardFuelFollowUp(orgId, { vehicleId: row.theft.vehicleId, followUpId: row.id, status: row.status })
  return row
}

export async function acceptFollowUp(orgId: string, id: string, userId: string) {
  const row = await load(orgId, id)
  if (row.dismissedById === userId) {
    throw new ForbiddenError('You deleted this alert, so its follow-up must be accepted by someone else')
  }
  if (row.status !== 'OPEN' || !(await repo.acceptFollowUp(id, row.theft.id, userId))) {
    const fresh = row.status === 'OPEN' ? await load(orgId, id) : row
    throw new ConflictError(`This follow-up was already accepted${fresh.acceptedBy ? ` by ${fresh.acceptedBy.fullName}` : ''}`)
  }
  return toDto(await changed(orgId, id), userId)
}

/** The owner check shared by notes and decisions. */
function assertOwner(row: FollowUpRow, userId: string) {
  if (row.status === 'OPEN') throw new ConflictError('Accept this follow-up before acting on it')
  if (row.status !== 'ACCEPTED') throw new ConflictError('This follow-up is already closed')
  if (row.acceptedById !== userId) {
    throw new ForbiddenError(`Only ${row.acceptedBy?.fullName ?? 'the account that accepted it'} can act on this follow-up`)
  }
}

export async function addNote(orgId: string, id: string, userId: string, note: string) {
  const row = await load(orgId, id)
  assertOwner(row, userId)
  await repo.addFollowUpNote(id, userId, note)
  return toDto(await changed(orgId, id), userId)
}

/** Escalate (a confirmed theft) or de-escalate (not a theft). */
export async function resolveFollowUp(
  orgId: string, id: string, userId: string,
  outcome: 'ESCALATED' | 'DEESCALATED', note: string,
) {
  const row = await load(orgId, id)
  assertOwner(row, userId)

  const me = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true } })
  const reviewer = me?.email ?? me?.fullName ?? userId
  const ok = await repo.resolveFollowUp({ id, theftId: row.theft.id, userId, reviewer, outcome, note })
  if (!ok) throw new ConflictError('This follow-up changed while you were deciding it. Reload and try again')

  const fresh = await changed(orgId, id)
  announce(orgId, fresh, outcome === 'ESCALATED' ? 'escalated' : 'deescalated')
  return toDto(fresh, userId)
}

/**
 * Put a follow-up event on the Live Feed. Never allowed to fail the request
 * that caused it: the follow-up itself is already stored.
 */
export function announce(orgId: string, row: FollowUpRow, what: 'opened' | 'escalated' | 'deescalated') {
  const t = row.theft
  const plate = t.vehicle.registrationPlate
  const incident = `${plate} fuel incident (${litres(t.stolenMl)})`
  const text = {
    opened:
      `FOLLOW-UP NEEDED: the ${incident} was deleted by ${row.dismissedBy?.fullName ?? 'an operator'}. ` +
      `Someone else must accept the follow-up and escalate or de-escalate it.`,
    escalated:
      `CONFIRMED FUEL THEFT: ${row.acceptedBy?.fullName ?? 'The reviewer'} escalated the follow-up on the ${incident}.`,
    deescalated:
      `FOLLOW-UP CLOSED: ${row.acceptedBy?.fullName ?? 'The reviewer'} de-escalated the ${incident} as not a theft.`,
  }[what]
  try {
    publishNotification({
      orgId,
      id: `fu-${row.id}-${what}`,
      source: 'fuel-followup',
      alertType: `FUEL_FOLLOWUP_${what.toUpperCase()}`,
      severity: what === 'escalated' ? 'critical' : what === 'opened' ? 'warning' : 'info',
      text,
      at: new Date(),
      plate,
      vehicleId: t.vehicleId,
      extra: { followUpId: row.id, incidentId: t.id },
    })
  } catch (err) {
    logger.warn({ err, followUpId: row.id }, 'Fuel follow-up: feed publish failed')
  }
}

/** Called by the dismissal once it has opened a follow-up. */
export async function followUpOpened(orgId: string, followUpId: string) {
  const row = await repo.findFollowUp(orgId, followUpId)
  if (!row) return
  emitDashboardFuelFollowUp(orgId, { vehicleId: row.theft.vehicleId, followUpId: row.id, status: row.status })
  announce(orgId, row, 'opened')
}
