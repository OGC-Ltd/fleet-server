/**
 * Storage for the follow-up a dismissed fuel incident opens. See
 * FuelTheftFollowUp in prisma/schema.prisma for the model and its rules.
 *
 * Every state change here is a conditional update (`updateMany` on the status
 * it expects) inside the same transaction as its log entry. Two people pressing
 * "Accept" in the same second is the ordinary race on a shared queue, and the
 * loser must get "already accepted", never a second owner.
 */

import { prisma } from '../../lib/prisma.js'
import type { Prisma } from '../../../generated/prisma/client.js'

export type FollowUpStatus = 'OPEN' | 'ACCEPTED' | 'ESCALATED' | 'DEESCALATED'

const PERSON = { select: { id: true, fullName: true } } as const

/** Everything the dashboard shows about a follow-up, log included. */
export const FOLLOW_UP_SELECT = {
  id: true,
  status: true,
  openedAt: true,
  acceptedAt: true,
  resolvedAt: true,
  assignedAt: true,
  dismissedById: true,
  acceptedById: true,
  assignedToId: true,
  dismissedBy: PERSON,
  acceptedBy: PERSON,
  assignedTo: PERSON,
  assignedBy: PERSON,
  theft: {
    select: {
      id: true, vehicleId: true, stolenMl: true, beganAt: true, detectedAt: true,
      drainCause: true, initialLocation: true,
      vehicle: { select: { registrationPlate: true } },
    },
  },
  actions: {
    orderBy: { at: 'asc' },
    select: { id: true, kind: true, note: true, at: true, actor: PERSON, subject: PERSON },
  },
} satisfies Prisma.FuelTheftFollowUpSelect

export type FollowUpRow = Prisma.FuelTheftFollowUpGetPayload<{ select: typeof FOLLOW_UP_SELECT }>

/** Which statuses each list filter means. */
export const STATUS_FILTER: Record<'open' | 'active' | 'closed' | 'all', FollowUpStatus[] | null> = {
  open:   ['OPEN'],
  // Still needing somebody: waiting to be taken on, or taken on and undecided.
  active: ['OPEN', 'ACCEPTED'],
  closed: ['ESCALATED', 'DEESCALATED'],
  all:    null,
}

export function listFollowUps(orgId: string, statuses: FollowUpStatus[] | null, limit: number) {
  return prisma.fuelTheftFollowUp.findMany({
    where: { organisationId: orgId, ...(statuses ? { status: { in: statuses } } : {}) },
    orderBy: { openedAt: 'desc' },
    take: limit,
    select: FOLLOW_UP_SELECT,
  })
}

export function findFollowUp(orgId: string, id: string) {
  return prisma.fuelTheftFollowUp.findFirst({
    where: { id, organisationId: orgId },
    select: FOLLOW_UP_SELECT,
  })
}

/**
 * Take on an OPEN follow-up. Returns false when somebody else got there first
 * (the row is no longer OPEN by the time this runs), or when an administrator
 * has meanwhile handed it to somebody else.
 */
export async function acceptFollowUp(id: string, theftId: string, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheftFollowUp.updateMany({
      where: { id, status: 'OPEN', OR: [{ assignedToId: null }, { assignedToId: userId }] },
      data: { status: 'ACCEPTED', acceptedById: userId, acceptedAt: now },
    })
    if (count === 0) return false
    await tx.fuelTheft.update({
      where: { id: theftId },
      data: { reviewStatus: 'UNDER_REVIEW', reviewedAt: now, reviewedById: userId },
    })
    await tx.fuelTheftFollowUpAction.create({
      data: { followUpId: id, kind: 'ACCEPTED', actorId: userId, at: now },
    })
    return true
  })
}

/** Log a note from the follow-up's owner. */
export function addFollowUpNote(id: string, userId: string, note: string) {
  return prisma.fuelTheftFollowUpAction.create({
    data: { followUpId: id, kind: 'NOTE', actorId: userId, note },
  })
}

/**
 * Close a follow-up its owner has decided. Returns false when it was no longer
 * theirs to decide (already closed, or somehow not accepted by them).
 *
 * The decision is ALSO written as a FuelEventLabel on the incident, THEFT for
 * an escalation and NOT_THEFT for a de-escalation. That table is the only
 * human check the detector has (see FuelEventLabel), and a follow-up is exactly
 * a human deciding what a flagged event was, so it goes there too.
 */
export async function resolveFollowUp(args: {
  id: string
  theftId: string
  userId: string
  reviewer: string
  outcome: 'ESCALATED' | 'DEESCALATED'
  note: string
}): Promise<boolean> {
  const { id, theftId, userId, reviewer, outcome, note } = args
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheftFollowUp.updateMany({
      where: { id, status: 'ACCEPTED', acceptedById: userId },
      data: { status: outcome, resolvedAt: now },
    })
    if (count === 0) return false
    await tx.fuelTheftFollowUpAction.create({
      data: { followUpId: id, kind: outcome, actorId: userId, note, at: now },
    })
    // The alert's own record, for analytics: see FuelTheft.reviewStatus.
    await tx.fuelTheft.update({
      where: { id: theftId },
      data: {
        reviewStatus: outcome === 'ESCALATED' ? 'CONFIRMED_THEFT' : 'NOT_THEFT',
        reviewedAt: now, reviewedById: userId, reviewNote: note,
      },
    })
    const label = outcome === 'ESCALATED' ? 'THEFT' : 'NOT_THEFT'
    await tx.fuelEventLabel.upsert({
      where: { eventId_eventType_labelledBy: { eventId: theftId, eventType: 'THEFT', labelledBy: reviewer } },
      create: { eventId: theftId, eventType: 'THEFT', label, labelledBy: reviewer, note },
      update: { label, note, labelledAt: now },
    })
    return true
  })
}

/**
 * Say no to an OPEN follow-up, with a reason. Returns false when it is no
 * longer OPEN, or no longer in the state the caller saw.
 *
 * Declining one that was ASSIGNED to the caller hands it back: the assignment
 * is cleared so an administrator can send it to somebody else. Declining an
 * unassigned one changes nothing on the row; the log entry is the whole
 * effect, and it is what marks the follow-up as needing an administrator.
 */
export async function declineFollowUp(id: string, userId: string, note: string, assignedToMe: boolean): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheftFollowUp.updateMany({
      where: assignedToMe
        ? { id, status: 'OPEN', assignedToId: userId }
        : { id, status: 'OPEN', assignedToId: null },
      data: { assignedToId: null, assignedById: null, assignedAt: null },
    })
    if (count === 0) return false
    await tx.fuelTheftFollowUpAction.create({
      data: { followUpId: id, kind: 'DECLINED', actorId: userId, note, at: now },
    })
    return true
  })
}

/**
 * An administrator hands a follow-up to somebody. Allowed while it is OPEN or
 * ACCEPTED: reassigning an accepted one takes it off its current owner, back
 * to OPEN, so the new person has to accept it themselves.
 */
export async function assignFollowUp(args: {
  id: string
  theftId: string
  byId: string
  toId: string
  note: string | null
}): Promise<boolean> {
  const { id, theftId, byId, toId, note } = args
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheftFollowUp.updateMany({
      where: { id, status: { in: ['OPEN', 'ACCEPTED'] } },
      data: {
        status: 'OPEN', acceptedById: null, acceptedAt: null,
        assignedToId: toId, assignedById: byId, assignedAt: now,
      },
    })
    if (count === 0) return false
    // Nobody is reviewing it until the new person accepts.
    await tx.fuelTheft.update({ where: { id: theftId }, data: { reviewStatus: 'DISMISSED' } })
    await tx.fuelTheftFollowUpAction.create({
      data: { followUpId: id, kind: 'ASSIGNED', actorId: byId, subjectId: toId, note, at: now },
    })
    return true
  })
}

/**
 * Who a follow-up in this organisation may be handed to: an active member of
 * it (employed here, or a live membership; the roster's test, see
 * repairs.authz) holding `fuel_theft:triage` through a live role here or a
 * platform role. Without case rights the assignee could not even open it.
 */
function assignableWhere(orgId: string): Prisma.UserWhereInput {
  return {
    deletedAt: null,
    status: { notIn: ['SUSPENDED', 'TERMINATED'] },
    OR: [
      { organisationId: orgId },
      { memberships: { some: { organisationId: orgId, revokedAt: null } } },
    ],
    userRoles: {
      some: {
        revokedAt: null,
        role: {
          OR: [{ organisationId: orgId }, { organisationId: null }],
          permissions: { some: { permission: { slug: 'fuel_theft:triage' } } },
        },
      },
    },
  }
}

export function listAssignees(orgId: string, excludeIds: string[]) {
  return prisma.user.findMany({
    where: { ...assignableWhere(orgId), id: { notIn: excludeIds } },
    select: { id: true, fullName: true, email: true },
    orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
  })
}

export async function isAssignable(orgId: string, userId: string): Promise<boolean> {
  const row = await prisma.user.findFirst({ where: { ...assignableWhere(orgId), id: userId }, select: { id: true } })
  return row !== null
}
