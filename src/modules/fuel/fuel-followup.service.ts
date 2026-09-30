/**
 * The follow-up a dismissed fuel incident opens — see FuelTheftFollowUp.
 *
 *   dismiss ─▶ OPEN ─accept─▶ ACCEPTED ─escalate───▶ ESCALATED   (confirmed theft)
 *               ▲                     ├─de-escalate─▶ DEESCALATED (not a theft)
 *               │                     └─probe fault─▶ PROBE_FAULT ─job fixed─▶ PROBE_FIXED
 *               └──── assign (administrator) ◀──┘
 *
 * PROBE_FAULT is the Fuel Audit: the owner found the "theft" was a faulty fuel
 * probe. It raises a pending probe job in Repairs (or joins the unit's open
 * one) and stays open until a technician signs that job off fixed; a sign-off
 * without a fix leaves it in audit for a new job to be raised.
 *
 * Who may do what:
 *   - accept:    anyone holding `fuel_theft:triage` (checked on the route),
 *                EXCEPT the account that deleted the alert. Once an
 *                administrator has assigned it, only the assignee.
 *   - decline:   anyone who could accept it, with a reason. Declining an
 *                assignment hands it back unassigned. A follow-up somebody
 *                has declined and nobody holds "needs assigning".
 *   - assign:    the organisation's system administrator or the platform
 *                administrator (the repairs rule, see repairs.authz), to an
 *                active member of the organisation who holds case rights and
 *                did not delete the alert. Works on OPEN and ACCEPTED ones;
 *                reassigning an accepted one returns it to OPEN.
 *   - recall:    the same administrators, taking it back from whoever holds
 *                it (the assignee, or the reviewer who accepted it). It
 *                returns to OPEN with nobody holding it.
 *   - note, escalate, de-escalate: only the account that accepted it.
 *
 * Every step is logged with its actor and mirrored onto the alert itself
 * (FuelTheft.reviewStatus), so the incident record always says where it stands.
 *
 * Every step is announced too: the opening, both outcomes, every assignment,
 * recall and decline go to the Live Feed, and every change goes to open
 * dashboards over SSE (`fuel_followup`) so the list updates without a reload.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { emitDashboardFuelFollowUp } from '../../lib/sse.js'
import { publishNotification } from '../../lib/notifications/notification.store.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors/errors.js'
// The administrators who hand out repair triages hand these out too; one rule
// for "who assigns work in this organisation" rather than two to drift apart.
import { canAssignTriage } from '../repairs/repairs.authz.js'
import * as repo from './fuel-followup.repository.js'
import type { FollowUpRow } from './fuel-followup.repository.js'
import type { ListFollowUpQuery } from './fuel.schema.js'
import { withEffectiveStage } from '../repairs/effective-stage.js'
import { overhaulFor } from '../repairs/repairs.overhaul.js'

const litres = (ml: number) => `${(ml / 1000).toFixed(1)} L`

/**
 * Has this viewer declined it, and not been handed it again since? A decline
 * that came before an assignment to them no longer stands: the administrator
 * has asked them again.
 */
function declinedBy(row: FollowUpRow, viewerId: string | null): boolean {
  if (!viewerId) return false
  let declined = false
  for (const a of row.actions) {
    if (a.kind === 'DECLINED' && a.actor?.id === viewerId) declined = true
    if (a.kind === 'ASSIGNED' && a.subject?.id === viewerId) declined = false
  }
  return declined
}

/** The follow-up as the dashboard reads it, with what THIS viewer may do. */
export function toDto(row: FollowUpRow, viewerId: string | null, canAssign = false) {
  const t = row.theft
  return {
    id: row.id,
    status: row.status,
    openedAt: row.openedAt,
    acceptedAt: row.acceptedAt,
    resolvedAt: row.resolvedAt,
    assignedAt: row.assignedAt,
    dismissedBy: row.dismissedBy,
    acceptedBy: row.acceptedBy,
    assignedTo: row.assignedTo,
    assignedBy: row.assignedBy,
    // Declined by somebody, and held by nobody: an administrator's to place.
    needsAssigning: row.status === 'OPEN' && !row.assignedToId && row.actions.some((a) => a.kind === 'DECLINED'),
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
    repairItem: row.repairItem ? withEffectiveStage(row.repairItem) : null,
    // Computed here so the rule lives in one place. The permission half
    // (`fuel_theft:triage`) is the client's to know; these are the parts only
    // the server can say.
    viewer: {
      deletedIt:    viewerId != null && row.dismissedById === viewerId,
      ownsIt:       viewerId != null && row.acceptedById === viewerId,
      assignedToMe: viewerId != null && row.assignedToId === viewerId,
      declinedIt:   declinedBy(row, viewerId),
      canAssign,
    },
  }
}

/** Whether this viewer is one of the organisation's assigners. */
async function viewerCanAssign(orgId: string, viewerId: string | null): Promise<boolean> {
  return viewerId != null && (await canAssignTriage(viewerId, orgId)).ok
}

export async function listFollowUps(orgId: string, q: ListFollowUpQuery, viewerId: string | null) {
  const [rows, canAssign] = await Promise.all([
    repo.listFollowUps(orgId, repo.STATUS_FILTER[q.status], q.limit),
    viewerCanAssign(orgId, viewerId),
  ])
  return rows.map((r) => toDto(r, viewerId, canAssign))
}

async function load(orgId: string, id: string) {
  const row = await repo.findFollowUp(orgId, id)
  if (!row) throw new NotFoundError('Fuel follow-up')
  return row
}

export async function getFollowUp(orgId: string, id: string, viewerId: string | null) {
  const [row, canAssign] = await Promise.all([load(orgId, id), viewerCanAssign(orgId, viewerId)])
  return toDto(row, viewerId, canAssign)
}

/** The same shape every write hands back: the fresh row, as this viewer sees it. */
async function dtoAfter(orgId: string, id: string, userId: string) {
  const [row, canAssign] = await Promise.all([changed(orgId, id), viewerCanAssign(orgId, userId)])
  return toDto(row, userId, canAssign)
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
  assertNotAssignedElsewhere(row, userId)
  if (row.status !== 'OPEN' || !(await repo.acceptFollowUp(id, row.theft.id, userId))) {
    const fresh = row.status === 'OPEN' ? await load(orgId, id) : row
    assertNotAssignedElsewhere(fresh, userId)
    throw new ConflictError(`This follow-up was already accepted${fresh.acceptedBy ? ` by ${fresh.acceptedBy.fullName}` : ''}`)
  }
  return dtoAfter(orgId, id, userId)
}

/** An assigned follow-up is the assignee's to accept or decline, nobody else's. */
function assertNotAssignedElsewhere(row: FollowUpRow, userId: string) {
  if (row.status === 'OPEN' && row.assignedToId && row.assignedToId !== userId) {
    throw new ForbiddenError(`This follow-up is assigned to ${row.assignedTo?.fullName ?? 'someone else'}; only they can accept or decline it`)
  }
}

/** Say no to an OPEN follow-up, with a reason. */
export async function declineFollowUp(orgId: string, id: string, userId: string, note: string) {
  const row = await load(orgId, id)
  if (row.status !== 'OPEN') throw new ConflictError('Only a follow-up waiting to be accepted can be declined')
  if (row.dismissedById === userId) {
    throw new ForbiddenError('You deleted this alert, so its follow-up is not yours to accept or decline')
  }
  assertNotAssignedElsewhere(row, userId)
  const assignedToMe = row.assignedToId === userId
  if (!assignedToMe && declinedBy(row, userId)) throw new ConflictError('You have already declined this follow-up')

  if (!(await repo.declineFollowUp(id, userId, note, assignedToMe))) {
    throw new ConflictError('This follow-up changed while you were declining it. Reload and try again')
  }
  const fresh = await changed(orgId, id)
  announce(orgId, fresh, 'declined')
  return toDto(fresh, userId, await viewerCanAssign(orgId, userId))
}

/** The people an administrator may hand this follow-up to. */
export async function listAssignees(orgId: string, id: string, userId: string) {
  await assertAssigner(orgId, userId)
  const row = await load(orgId, id)
  return repo.listAssignees(orgId, row.dismissedById ? [row.dismissedById] : [])
}

async function assertAssigner(orgId: string, userId: string) {
  const check = await canAssignTriage(userId, orgId)
  if (!check.ok) {
    throw new ForbiddenError(check.reason === 'not_a_member'
      ? 'Only an administrator of this organisation can assign a follow-up'
      : 'Only a system administrator or the platform administrator can assign a follow-up')
  }
}

/** An administrator takes the follow-up back from whoever holds it. */
export async function recallFollowUp(
  orgId: string, id: string, userId: string,
  dto: { note?: string | null },
) {
  await assertAssigner(orgId, userId)
  const row = await load(orgId, id)
  if (row.status !== 'OPEN' && row.status !== 'ACCEPTED') throw new ConflictError('This follow-up is already closed')
  const from = row.status === 'ACCEPTED' ? 'accepted' as const : 'assigned' as const
  const fromId = row.status === 'ACCEPTED' ? row.acceptedById : row.assignedToId
  if (!fromId) throw new ConflictError('Nobody holds this follow-up, so there is nothing to recall')

  const ok = await repo.recallFollowUp({
    id, theftId: row.theft.id, byId: userId, fromId, from, note: dto.note?.trim() || null,
  })
  if (!ok) throw new ConflictError('This follow-up changed while you were recalling it. Reload and try again')
  const fresh = await changed(orgId, id)
  announce(orgId, fresh, 'recalled')
  return toDto(fresh, userId, true)
}

/** An administrator hands the follow-up to somebody. */
export async function assignFollowUp(
  orgId: string, id: string, userId: string,
  dto: { assigneeId: string; note?: string | null },
) {
  await assertAssigner(orgId, userId)
  const row = await load(orgId, id)
  if (row.status !== 'OPEN' && row.status !== 'ACCEPTED') throw new ConflictError('This follow-up is already closed')
  if (dto.assigneeId === row.dismissedById) {
    throw new ForbiddenError('The account that deleted the alert cannot be assigned its follow-up')
  }
  const current = row.status === 'OPEN' ? row.assignedToId : row.acceptedById
  if (current === dto.assigneeId) throw new ConflictError('This follow-up is already with that person')
  if (!(await repo.isAssignable(orgId, dto.assigneeId))) {
    throw new ForbiddenError('That person is not an active member of this organisation with fuel case rights')
  }

  const ok = await repo.assignFollowUp({
    id, theftId: row.theft.id, byId: userId, toId: dto.assigneeId, note: dto.note?.trim() || null,
  })
  if (!ok) throw new ConflictError('This follow-up changed while you were assigning it. Reload and try again')
  const fresh = await changed(orgId, id)
  announce(orgId, fresh, 'assigned')
  return toDto(fresh, userId, true)
}

/** The owner check shared by notes and decisions. */
function assertOwner(row: FollowUpRow, userId: string) {
  if (row.status === 'OPEN') throw new ConflictError('Accept this follow-up before acting on it')
  if (row.status === 'PROBE_FAULT') throw new ConflictError('This case is in Fuel Audit, waiting on its probe repair')
  if (row.status !== 'ACCEPTED') throw new ConflictError('This follow-up is already closed')
  if (row.acceptedById !== userId) {
    throw new ForbiddenError(`Only ${row.acceptedBy?.fullName ?? 'the account that accepted it'} can act on this follow-up`)
  }
}

export async function addNote(orgId: string, id: string, userId: string, note: string) {
  const row = await load(orgId, id)
  assertOwner(row, userId)
  await repo.addFollowUpNote(id, userId, note)
  return dtoAfter(orgId, id, userId)
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
  return toDto(fresh, userId, await viewerCanAssign(orgId, userId))
}

// ── Fuel Audit ──────────────────────────────────────────────────────────────

async function whoIs(userId: string) {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true } })
  return { reviewer: me?.email ?? me?.fullName ?? userId, name: me?.fullName ?? null }
}

/** The owner decides the case was a faulty fuel probe: see PROBE_FAULT. */
export async function markProbeFault(orgId: string, id: string, userId: string, note: string) {
  const row = await load(orgId, id)
  assertOwner(row, userId)
  const me = await whoIs(userId)
  const done = await repo.markProbeFault({
    id, orgId, theftId: row.theft.id, vehicleId: row.theft.vehicleId, plate: row.theft.vehicle.registrationPlate,
    userId, userName: me.name, reviewer: me.reviewer, note,
  })
  if (!done) throw new ConflictError('This follow-up changed while you were deciding it. Reload and try again')
  const fresh = await changed(orgId, id)
  announce(orgId, fresh, 'probe_fault')
  return toDto(fresh, userId, await viewerCanAssign(orgId, userId))
}

/**
 * A live alert escalated as a faulty probe from its window (administrators;
 * the caller checks). Opens its case straight into PROBE_FAULT: see
 * repo.openAsProbeFault. Returns null when the alert is not in this
 * organisation, 'dismissed' when it was deleted first.
 */
export async function escalateLiveAsProbeFault(orgId: string, theftId: string, userId: string, note: string) {
  const me = await whoIs(userId)
  const done = await repo.openAsProbeFault({ orgId, theftId, userId, userName: me.name, reviewer: me.reviewer, note })
  if (!done || done === 'dismissed') return done
  const row = await changed(orgId, done.followUpId)
  announce(orgId, row, 'probe_fault')
  return { ...done, reviewedBy: me.name }
}

/** A new probe job for a case whose last one was signed off without a fix. */
export async function reraiseRepair(orgId: string, id: string, userId: string, note: string) {
  const row = await load(orgId, id)
  if (row.status !== 'PROBE_FAULT') throw new ConflictError('Only a case waiting on a probe repair can have one raised')
  if (row.repairItem && !row.repairItem.resolvedAt) {
    throw new ConflictError('The probe job for this case is still open in Repairs')
  }
  const me = await whoIs(userId)
  const done = await repo.reraiseProbeJob({
    id, orgId, vehicleId: row.theft.vehicleId, plate: row.theft.vehicle.registrationPlate,
    userId, userName: me.name, note,
  })
  if (!done) throw new ConflictError('This case changed while you were raising the job. Reload and try again')
  const fresh = await changed(orgId, id)
  announce(orgId, fresh, 'repair_raised')
  return toDto(fresh, userId, await viewerCanAssign(orgId, userId))
}

/**
 * Called by Repairs once a job is signed off: fixed closes the cases waiting
 * on it, failed is logged on them. Never throws; the sign-off is already
 * stored, and the Audit page catches up on its next read if this fails.
 */
export async function repairSignedOff(orgId: string, repairItemId: string) {
  try {
    const ids = await repo.applyRepairSignOff(repairItemId)
    for (const id of ids) {
      const row = await changed(orgId, id)
      announce(orgId, row, row.status === 'PROBE_FIXED' ? 'probe_fixed' : 'repair_failed')
    }
  } catch (err) {
    logger.warn({ err, repairItemId }, 'Fuel audit: could not apply a repair sign-off')
  }
}

/**
 * The Fuel Audit page: every case found to be a faulty probe, grouped by
 * unit, with each unit's probe jobs in Repairs and its dead-probe episodes.
 */
export async function listAudit(orgId: string, viewerId: string | null) {
  // Catch up any sign-off whose hook did not land.
  for (const itemId of await repo.unsyncedSignOffs(orgId)) await repairSignedOff(orgId, itemId)

  const [rows, canAssign] = await Promise.all([
    repo.listFollowUps(orgId, repo.STATUS_FILTER.audit, 200),
    viewerCanAssign(orgId, viewerId),
  ])
  const cases = rows.map((r) => toDto(r, viewerId, canAssign))
  const vehicleIds = [...new Set(cases.map((c) => c.incident.vehicleId))]
  const { jobs, episodes } = await repo.probeHistory(orgId, vehicleIds)
  // The overhaul record (checklist and spares) of every job a case points at.
  const jobIds = [...new Set(cases.map((c) => c.repairItem?.id).filter((x): x is string => !!x))]
  const { parts, inspections } = await overhaulFor(jobIds)

  const units = vehicleIds.map((vehicleId) => {
    const mine = cases.filter((c) => c.incident.vehicleId === vehicleId)
    const lastAlertAt = mine.reduce((m, c) => (c.incident.beganAt > m ? c.incident.beganAt : m), mine[0].incident.beganAt)
    return {
      vehicleId,
      plate: mine[0].incident.plate,
      openCases: mine.filter((c) => c.status === 'PROBE_FAULT').length,
      fixedCases: mine.filter((c) => c.status === 'PROBE_FIXED').length,
      lastAlertAt,
      cases: mine,
      repairs: jobs.filter((j) => j.vehicleId === vehicleId),
      overhaul: Object.fromEntries(
        [...new Set(mine.map((c) => c.repairItem?.id).filter((x): x is string => !!x))].map((id) => [id, {
          parts: parts.filter((x) => x.repairItemId === id),
          inspections: inspections.filter((x) => x.repairItemId === id),
        }]),
      ),
      probeFaults: episodes.filter((e) => e.vehicleId === vehicleId),
    }
  })
  // Units still waiting on a repair first, then the most recent alert.
  units.sort((a, b) => (Number(b.openCases > 0) - Number(a.openCases > 0))
    || (b.lastAlertAt.getTime() - a.lastAlertAt.getTime()))
  return units
}

/**
 * Put a follow-up event on the Live Feed. Never allowed to fail the request
 * that caused it: the follow-up itself is already stored.
 */
export type Announcement = 'opened' | 'escalated' | 'deescalated' | 'assigned' | 'declined' | 'recalled'
  | 'probe_fault' | 'repair_raised' | 'repair_failed' | 'probe_fixed'

export function announce(orgId: string, row: FollowUpRow, what: Announcement) {
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
    assigned:
      `FOLLOW-UP ASSIGNED: ${row.assignedBy?.fullName ?? 'An administrator'} assigned the follow-up on the ${incident} ` +
      `to ${row.assignedTo?.fullName ?? 'a reviewer'}, who must accept or decline it.`,
    declined:
      `FOLLOW-UP DECLINED: ${lastDecliner(row) ?? 'A reviewer'} declined the follow-up on the ${incident}. ` +
      `An administrator must assign it to someone.`,
    recalled:
      `FOLLOW-UP RECALLED: ${lastOf(row, 'RECALLED')?.actor?.fullName ?? 'An administrator'} took the follow-up on the ` +
      `${incident} back from ${lastOf(row, 'RECALLED')?.subject?.fullName ?? 'its holder'}. It is open again.`,
    probe_fault:
      `FAULTY FUEL PROBE: ${row.acceptedBy?.fullName ?? 'The reviewer'} found the ${incident} was a faulty probe, ` +
      `not a theft. A probe repair for ${plate} is pending in Maintenance > Repairs.`,
    repair_raised:
      `FUEL AUDIT: a new probe repair for ${plate} is pending in Maintenance > Repairs.`,
    repair_failed:
      `FUEL AUDIT: the probe repair on ${plate} was signed off without a fix. The case stays open in Fuel Audit.`,
    probe_fixed:
      `FUEL AUDIT CLOSED: the probe on ${plate} was repaired, closing the case on the ${incident}.`,
  }[what]
  try {
    publishNotification({
      orgId,
      // Opening and the two outcomes happen once per follow-up; assigning and
      // declining can repeat, so those ids carry a time to stay unique.
      id: what === 'assigned' || what === 'declined' || what === 'recalled' || what === 'repair_raised' || what === 'repair_failed'
        ? `fu-${row.id}-${what}-${Date.now()}`
        : `fu-${row.id}-${what}`,
      source: 'fuel-followup',
      alertType: `FUEL_FOLLOWUP_${what.toUpperCase()}`,
      severity: what === 'escalated' ? 'critical'
        : what === 'opened' || what === 'declined' || what === 'probe_fault' || what === 'repair_failed' ? 'warning' : 'info',
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

/** The most recent log entry of one kind. */
function lastOf(row: FollowUpRow, kind: FollowUpRow['actions'][number]['kind']) {
  return [...row.actions].reverse().find((a) => a.kind === kind) ?? null
}

/** Who declined most recently, for the feed line. */
function lastDecliner(row: FollowUpRow): string | null {
  return lastOf(row, 'DECLINED')?.actor?.fullName ?? null
}
