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
  dismissedById: true,
  acceptedById: true,
  dismissedBy: PERSON,
  acceptedBy: PERSON,
  theft: {
    select: {
      id: true, vehicleId: true, stolenMl: true, beganAt: true, detectedAt: true,
      drainCause: true, initialLocation: true,
      vehicle: { select: { registrationPlate: true } },
    },
  },
  actions: {
    orderBy: { at: 'asc' },
    select: { id: true, kind: true, note: true, at: true, actor: PERSON },
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
 * (the row is no longer OPEN by the time this runs).
 */
export async function acceptFollowUp(id: string, theftId: string, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheftFollowUp.updateMany({
      where: { id, status: 'OPEN' },
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
