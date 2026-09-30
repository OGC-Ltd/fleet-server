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

export type FollowUpStatus = 'OPEN' | 'ACCEPTED' | 'ESCALATED' | 'DEESCALATED' | 'PROBE_FAULT' | 'PROBE_FIXED'

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
  repairItemId: true,
  repairItem: {
    select: {
      id: true, stage: true, outcome: true, resolvedAt: true, fixNote: true, assignmentStatus: true,
      expectedResolutionAt: true, stageChangedAt: true, stageHistory: true, createdAt: true,
      assignedTo: PERSON, resolvedBy: PERSON,
    },
  },
} satisfies Prisma.FuelTheftFollowUpSelect

export type FollowUpRow = Prisma.FuelTheftFollowUpGetPayload<{ select: typeof FOLLOW_UP_SELECT }>

/** Which statuses each list filter means. */
export const STATUS_FILTER: Record<'open' | 'active' | 'closed' | 'audit' | 'all', FollowUpStatus[] | null> = {
  open:   ['OPEN'],
  // Still needing somebody: waiting to be taken on, or taken on and undecided.
  active: ['OPEN', 'ACCEPTED'],
  closed: ['ESCALATED', 'DEESCALATED', 'PROBE_FIXED'],
  // The Fuel Audit page: found to be a faulty probe, repaired or not yet.
  audit:  ['PROBE_FAULT', 'PROBE_FIXED'],
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

/**
 * An administrator takes a follow-up back from whoever has it: the person it
 * was assigned to (not yet accepted), or the reviewer who accepted it. It
 * returns to OPEN with nobody holding it. Returns false when it no longer has
 * that holder by the time this runs.
 */
export async function recallFollowUp(args: {
  id: string
  theftId: string
  byId: string
  fromId: string
  from: 'assigned' | 'accepted'
  note: string | null
}): Promise<boolean> {
  const { id, theftId, byId, fromId, from, note } = args
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheftFollowUp.updateMany({
      where: from === 'assigned'
        ? { id, status: 'OPEN', assignedToId: fromId }
        : { id, status: 'ACCEPTED', acceptedById: fromId },
      data: {
        status: 'OPEN', acceptedById: null, acceptedAt: null,
        assignedToId: null, assignedById: null, assignedAt: null,
      },
    })
    if (count === 0) return false
    // Nobody is reviewing it any more.
    await tx.fuelTheft.update({ where: { id: theftId }, data: { reviewStatus: 'DISMISSED' } })
    await tx.fuelTheftFollowUpAction.create({
      data: { followUpId: id, kind: 'RECALLED', actorId: byId, subjectId: fromId, note, at: now },
    })
    return true
  })
}

// ── Fuel Audit: faulty probes ───────────────────────────────────────────────

/** The unit's open probe job in Repairs, if it has one (at most one: see the
 *  open-target index, repair_report_items_open_target_uniq). */
function openProbeJob(tx: Prisma.TransactionClient, vehicleId: string) {
  return tx.repairReportItem.findFirst({
    where: { vehicleId, targetKind: 'probe', resolvedAt: null },
    select: { id: true },
  })
}

/**
 * Raise a pending probe job for the unit, or return the one already open.
 * Filed as a one-item repair report by the case owner, outcome 'audit': no
 * technician has been out yet, which is what 'pending' says on the ladder.
 */
async function raiseProbeJob(
  tx: Prisma.TransactionClient,
  args: { orgId: string; vehicleId: string; userId: string; userName: string | null; plate: string; note: string },
): Promise<{ id: string; joined: boolean }> {
  const open = await openProbeJob(tx, args.vehicleId)
  if (open) return { id: open.id, joined: true }
  const at = new Date()
  const report = await tx.repairReport.create({
    data: {
      organisationId: args.orgId,
      reportedById: args.userId,
      note: `Raised by Fuel Audit: a fuel theft alert on ${args.plate} was found to be a faulty fuel probe.`,
      // The mail is the technician report's; an audit job goes to the Live
      // Feed instead (see the service).
      emailStatus: 'no-recipients',
      items: {
        create: [{
          organisationId: args.orgId,
          targetKind: 'probe',
          vehicleId: args.vehicleId,
          outcome: 'audit',
          stage: 'pending',
          problemNote: args.note,
          stageChangedAt: at,
          stageHistory: [{
            stage: 'pending', at: at.toISOString(), by: args.userId,
            ...(args.userName ? { byName: args.userName } : {}),
            note: 'Raised by Fuel Audit',
          }],
        }],
      },
    },
    select: { items: { select: { id: true } } },
  })
  return { id: report.items[0].id, joined: false }
}

/**
 * The owner decides the case was a faulty fuel probe. In one transaction: the
 * case moves to PROBE_FAULT (still open, on the Audit page), a probe job is
 * raised in Repairs or the unit's open one is joined, and the alert and the
 * label table record "not a theft". Returns null when the case was no longer
 * the caller's to decide.
 */
export async function markProbeFault(args: {
  id: string
  orgId: string
  theftId: string
  vehicleId: string
  plate: string
  userId: string
  userName: string | null
  reviewer: string
  note: string
}): Promise<{ repairItemId: string; joined: boolean } | null> {
  const { id, orgId, theftId, vehicleId, plate, userId, userName, reviewer, note } = args
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheftFollowUp.updateMany({
      where: { id, status: 'ACCEPTED', acceptedById: userId },
      data: { status: 'PROBE_FAULT' },
    })
    if (count === 0) return null
    const job = await raiseProbeJob(tx, { orgId, vehicleId, userId, userName, plate, note })
    await tx.fuelTheftFollowUp.update({ where: { id }, data: { repairItemId: job.id } })
    await tx.fuelTheftFollowUpAction.create({
      data: { followUpId: id, kind: 'PROBE_FAULT', actorId: userId, note, at: now },
    })
    await tx.fuelTheftFollowUpAction.create({
      data: {
        followUpId: id, kind: 'REPAIR_RAISED', actorId: userId, at: new Date(now.getTime() + 1),
        note: job.joined
          ? 'Linked to the probe job already open for this unit in Repairs'
          : 'Pending probe job raised in Repairs',
      },
    })
    await tx.fuelTheft.update({
      where: { id: theftId },
      data: { reviewStatus: 'PROBE_FAULT', reviewedAt: now, reviewedById: userId, reviewNote: note },
    })
    const labelNote = `Faulty fuel probe: ${note}`
    await tx.fuelEventLabel.upsert({
      where: { eventId_eventType_labelledBy: { eventId: theftId, eventType: 'THEFT', labelledBy: reviewer } },
      create: { eventId: theftId, eventType: 'THEFT', label: 'NOT_THEFT', labelledBy: reviewer, note: labelNote },
      update: { label: 'NOT_THEFT', note: labelNote, labelledAt: now },
    })
    return { repairItemId: job.id, joined: job.joined }
  })
}

/**
 * An administrator escalates a LIVE alert as a faulty fuel probe from its
 * window. There is no case yet, so one is opened straight into PROBE_FAULT,
 * held by that administrator: the alert leaves the dashboard (it is not a
 * theft), lands on the Audit page, and a probe job is raised or joined, all
 * in one transaction. Returns 'dismissed' when the alert was deleted first,
 * and so already has a case of its own.
 */
export async function openAsProbeFault(args: {
  orgId: string
  theftId: string
  userId: string
  userName: string | null
  reviewer: string
  note: string
}): Promise<{ followUpId: string; vehicleId: string; repairItemId: string; joined: boolean } | 'dismissed' | null> {
  const { orgId, theftId, userId, userName, reviewer, note } = args
  const row = await prisma.fuelTheft.findFirst({
    where: { id: theftId, vehicle: { organisationId: orgId } },
    select: { id: true, dismissedAt: true },
  })
  if (!row) return null
  if (row.dismissedAt) return 'dismissed'
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.fuelTheft.updateMany({
      where: { id: theftId, dismissedAt: null },
      data: {
        dismissedAt: now, dismissedById: userId,
        reviewStatus: 'PROBE_FAULT', reviewedAt: now, reviewedById: userId, reviewNote: note,
      },
    })
    if (count === 0) return 'dismissed' as const
    const full = await tx.fuelTheft.findUniqueOrThrow({
      where: { id: theftId },
      include: {
        vehicle: { select: { registrationPlate: true, name: true } },
        driver: { select: { fullName: true } },
      },
    })
    const job = await raiseProbeJob(tx, {
      orgId, vehicleId: full.vehicleId, userId, userName, plate: full.vehicle.registrationPlate, note,
    })
    const followUp = await tx.fuelTheftFollowUp.create({
      data: {
        organisationId: orgId, theftId, openedAt: now, status: 'PROBE_FAULT',
        dismissedById: userId, acceptedById: userId, acceptedAt: now, repairItemId: job.id,
        incidentSnapshot: JSON.parse(JSON.stringify(full)) as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    await tx.fuelTheftFollowUpAction.create({
      data: { followUpId: followUp.id, kind: 'PROBE_FAULT', actorId: userId, note, at: now },
    })
    await tx.fuelTheftFollowUpAction.create({
      data: {
        followUpId: followUp.id, kind: 'REPAIR_RAISED', actorId: userId, at: new Date(now.getTime() + 1),
        note: job.joined
          ? 'Linked to the probe job already open for this unit in Repairs'
          : 'Pending probe job raised in Repairs',
      },
    })
    const labelNote = `Faulty fuel probe: ${note}`
    await tx.fuelEventLabel.upsert({
      where: { eventId_eventType_labelledBy: { eventId: theftId, eventType: 'THEFT', labelledBy: reviewer } },
      create: { eventId: theftId, eventType: 'THEFT', label: 'NOT_THEFT', labelledBy: reviewer, note: labelNote },
      update: { label: 'NOT_THEFT', note: labelNote, labelledAt: now },
    })
    return { followUpId: followUp.id, vehicleId: full.vehicleId, repairItemId: job.id, joined: job.joined }
  })
}

/**
 * A PROBE_FAULT case whose job was signed off without a fix gets a new job,
 * or joins one somebody has opened since. Returns null when the case is no
 * longer waiting on a repair, or its current job is still open.
 */
export async function reraiseProbeJob(args: {
  id: string
  orgId: string
  vehicleId: string
  plate: string
  userId: string
  userName: string | null
  note: string
}): Promise<{ repairItemId: string; joined: boolean } | null> {
  const { id, orgId, vehicleId, plate, userId, userName, note } = args
  return prisma.$transaction(async (tx) => {
    const row = await tx.fuelTheftFollowUp.findFirst({
      where: { id, organisationId: orgId, status: 'PROBE_FAULT' },
      select: { repairItem: { select: { resolvedAt: true } } },
    })
    if (!row || (row.repairItem && !row.repairItem.resolvedAt)) return null
    const job = await raiseProbeJob(tx, { orgId, vehicleId, userId, userName, plate, note })
    await tx.fuelTheftFollowUp.update({ where: { id }, data: { repairItemId: job.id } })
    await tx.fuelTheftFollowUpAction.create({
      data: {
        followUpId: id, kind: 'REPAIR_RAISED', actorId: userId, at: new Date(),
        note: job.joined
          ? `Linked to the probe job already open for this unit in Repairs. ${note}`
          : `New pending probe job raised in Repairs. ${note}`,
      },
    })
    return { repairItemId: job.id, joined: job.joined }
  })
}

/**
 * Carry a repair sign-off onto the cases waiting on that job. Fixed closes
 * them (PROBE_FIXED); failed is logged and leaves them in audit. Idempotent:
 * only PROBE_FAULT cases still linked to the job move, and a failure is logged
 * once. Returns the ids that changed.
 */
export async function applyRepairSignOff(repairItemId: string): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.repairReportItem.findUnique({
      where: { id: repairItemId },
      select: { stage: true, resolvedAt: true, resolvedById: true, fixNote: true },
    })
    const resolvedAt = item?.resolvedAt
    if (!item || !resolvedAt) return []
    const cases = await tx.fuelTheftFollowUp.findMany({
      where: { repairItemId, status: 'PROBE_FAULT' },
      select: { id: true, actions: { where: { kind: 'REPAIR_FAILED' }, select: { at: true } } },
    })
    const changed: string[] = []
    for (const c of cases) {
      if (item.stage === 'fixed') {
        const { count } = await tx.fuelTheftFollowUp.updateMany({
          where: { id: c.id, status: 'PROBE_FAULT', repairItemId },
          data: { status: 'PROBE_FIXED', resolvedAt },
        })
        if (count === 0) continue
        await tx.fuelTheftFollowUpAction.create({
          data: {
            followUpId: c.id, kind: 'PROBE_FIXED', actorId: item.resolvedById, at: resolvedAt,
            note: item.fixNote ? `Probe repair signed off fixed: ${item.fixNote}` : 'Probe repair signed off fixed',
          },
        })
        changed.push(c.id)
      } else if (!c.actions.some((a) => a.at.getTime() >= resolvedAt.getTime())) {
        await tx.fuelTheftFollowUpAction.create({
          data: {
            followUpId: c.id, kind: 'REPAIR_FAILED', actorId: item.resolvedById, at: resolvedAt,
            note: item.fixNote
              ? `Probe repair signed off without a fix: ${item.fixNote}`
              : 'Probe repair signed off without a fix',
          },
        })
        changed.push(c.id)
      }
    }
    return changed
  })
}

/** Repair jobs signed off while PROBE_FAULT cases still wait on them: the
 *  Audit page's catch-up, so a sign-off whose hook failed is applied on the
 *  next read. */
export async function unsyncedSignOffs(orgId: string): Promise<string[]> {
  const rows = await prisma.fuelTheftFollowUp.findMany({
    where: { organisationId: orgId, status: 'PROBE_FAULT', repairItem: { resolvedAt: { not: null } } },
    select: { repairItemId: true },
  })
  return [...new Set(rows.map((r) => r.repairItemId).filter((x): x is string => !!x))]
}

/** The fuel probe record of some units, for the Audit page: every probe job
 *  each has had in Repairs, and its dead-probe fault episodes. */
export async function probeHistory(orgId: string, vehicleIds: string[]) {
  if (vehicleIds.length === 0) return { jobs: [], episodes: [] }
  const [jobs, episodes] = await Promise.all([
    prisma.repairReportItem.findMany({
      where: { organisationId: orgId, targetKind: 'probe', vehicleId: { in: vehicleIds } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true, vehicleId: true, outcome: true, stage: true, createdAt: true, resolvedAt: true,
        problemNote: true, fixNote: true, sparePart: true, expectedResolutionAt: true,
        report: { select: { reportedBy: PERSON } },
        assignedTo: PERSON, resolvedBy: PERSON,
      },
    }),
    prisma.sensorFaultEpisode.findMany({
      where: { organisationId: orgId, kind: 'fuel_probe_dead', vehicleId: { in: vehicleIds } },
      orderBy: { startedAt: 'desc' },
      take: 500,
      select: { id: true, vehicleId: true, startedAt: true, recoveredAt: true, durationSec: true, detail: true },
    }),
  ])
  return { jobs, episodes }
}
