import { prisma } from '../../lib/prisma.js'
import type { Prisma } from '../../../generated/prisma/client.js'
import { ANNOUNCED_CAUSES } from './fuel-theft-classifier.js'
import { FUEL_INCIDENT_WINDOW_MS, FUEL_INCIDENT_EPOCH, incidentReasonSlugs } from '../telemetry/telemetry.repository.js'
import { fuelChoices } from '../alerts/alerts.rules.js'
import type { CreateFillingDto, ListFillingQuery, CreateTheftDto, ListTheftQuery } from './fuel.schema.js'

function buildDateFilter(from?: Date, to?: Date) {
  if (!from && !to) return undefined
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
}

// ── Fillings ─────────────────────────────────────────────────────────────────

/** `db`: the report pool (lib/report-db) when a Fuel Report asks; the live pool otherwise. */
export async function findAllFillings(orgId: string, q: ListFillingQuery, db: typeof prisma = prisma) {
  const dateFilter = buildDateFilter(q.from, q.to)
  const where = {
    vehicle: { organisationId: orgId },
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.reportingPeriodId ? { reportingPeriodId: q.reportingPeriodId } : {}),
    ...(dateFilter ? { filledAt: dateFilter } : {}),
  }
  const items = await db.fuelFilling.findMany({
    where,
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    orderBy: { filledAt: 'desc' },
    include: { vehicle: { select: { id: true, name: true, registrationPlate: true } } },
  })
  const hasNextPage = items.length > q.limit
  if (hasNextPage) items.pop()
  return { data: items, cursor: items.at(-1)?.id ?? null, hasNextPage }
}

export async function findFillingById(orgId: string, id: string) {
  return prisma.fuelFilling.findFirst({
    where: { id, vehicle: { organisationId: orgId } },
    include: { vehicle: { select: { id: true, name: true } }, reportingPeriod: { select: { id: true, label: true } } },
  })
}

export async function createFilling(dto: CreateFillingDto) {
  return prisma.fuelFilling.create({ data: dto })
}

// ── Thefts ───────────────────────────────────────────────────────────────────

export async function findAllThefts(orgId: string, q: ListTheftQuery, db: typeof prisma = prisma) {
  const dateFilter = buildDateFilter(q.from, q.to)
  const where = {
    vehicle: { organisationId: orgId },
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.reportingPeriodId ? { reportingPeriodId: q.reportingPeriodId } : {}),
    ...(dateFilter ? { beganAt: dateFilter } : {}),
    ...(q.reviewStatus ? { reviewStatus: q.reviewStatus === 'none' ? null : q.reviewStatus } : {}),
  }
  const items = await db.fuelTheft.findMany({
    where,
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    orderBy: { beganAt: 'desc' },
    include: {
      vehicle: { select: { id: true, name: true, registrationPlate: true } },
      driver: { select: { id: true, fullName: true } },
      dismissedBy: { select: { id: true, fullName: true } },
      reviewedBy: { select: { id: true, fullName: true } },
      followUp: { select: { id: true, status: true, acceptedBy: { select: { id: true, fullName: true } } } },
    },
  })
  const hasNextPage = items.length > q.limit
  if (hasNextPage) items.pop()
  return { data: items, cursor: items.at(-1)?.id ?? null, hasNextPage }
}

export async function findTheftById(orgId: string, id: string) {
  return prisma.fuelTheft.findFirst({
    where: { id, vehicle: { organisationId: orgId } },
    include: {
      vehicle: { select: { id: true, name: true } },
      driver: { select: { id: true, fullName: true } },
      reportingPeriod: { select: { id: true, label: true } },
    },
  })
}

/**
 * An administrator's decision on an alert: escalated (a confirmed theft) or
 * de-escalated (not a theft). Written to the same places a follow-up's outcome
 * is (FuelTheft.reviewStatus for analytics, a FuelEventLabel for the detector)
 * so the two routes to a decision are one record, and logged in
 * alert_decisions with every decision before it.
 *
 * Which decisions an alert still takes is alerts.scope fuelChoices: an
 * undecided one either; one decided here, the other (changing one's mind,
 * from the Alerts page); one deleted before Delete was retired, either, which
 * also closes its waiting case. Returns 'dismissed' when the alert takes no
 * such decision (escalated as a faulty probe, or decided in its case), null
 * when it is not in this organisation.
 */
export async function reviewTheft(args: {
  orgId: string
  id: string
  userId: string
  reviewer: string
  outcome: 'ESCALATED' | 'DEESCALATED'
  note: string
}) {
  const { orgId, id, userId, reviewer, outcome, note } = args
  const row = await prisma.fuelTheft.findFirst({
    where: { id, vehicle: { organisationId: orgId } },
    select: {
      id: true, vehicleId: true, beganAt: true, dismissedAt: true, reviewStatus: true, reviewedAt: true,
      followUp: { select: { id: true, status: true } },
    },
  })
  if (!row) return null
  const choice = outcome === 'ESCALATED' ? 'theft' : 'not_theft'
  if (!fuelChoices({ reviewStatus: row.reviewStatus, followUpStatus: row.followUp?.status }).includes(choice)) {
    return 'dismissed' as const
  }
  const live = row.dismissedAt == null
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const reviewStatus = outcome === 'ESCALATED' ? 'CONFIRMED_THEFT' as const : 'NOT_THEFT' as const
    // Deciding an alert is the ONLY way it leaves the dashboard (operator,
    // 2026-09-30: no Delete button, so nothing goes without a trail). The
    // decision, its note and who made it stay on the row. Conditional on the
    // row still standing as it was read, so a decision that lands first wins.
    const { count } = await tx.fuelTheft.updateMany({
      where: live ? { id, dismissedAt: null } : { id, reviewStatus: row.reviewStatus, reviewedAt: row.reviewedAt },
      data: {
        reviewStatus, reviewedAt: now, reviewedById: userId, reviewNote: note,
        ...(live ? { dismissedAt: now, dismissedById: userId } : {}),
      },
    })
    if (count === 0) return 'dismissed' as const
    // Only a decision that takes the alert off the map uncovers the unit's
    // older ones there; changing an earlier decision moves nothing.
    const dismissedIds = live
      ? await sweepUnitSiblings(tx, { id, vehicleId: row.vehicleId, userId, now, beganAt: row.beganAt })
      : []
    // Deleted before Delete was retired and still waiting in its case: the
    // decision closes the case, logged there as its owner's would be.
    if (row.followUp && (row.followUp.status === 'OPEN' || row.followUp.status === 'ACCEPTED')) {
      await tx.fuelTheftFollowUp.update({
        where: { id: row.followUp.id },
        data: { status: outcome, resolvedAt: now },
      })
      await tx.fuelTheftFollowUpAction.create({
        data: { followUpId: row.followUp.id, kind: outcome, actorId: userId, note, at: now },
      })
    }
    const label = outcome === 'ESCALATED' ? 'THEFT' : 'NOT_THEFT'
    await tx.fuelEventLabel.upsert({
      where: { eventId_eventType_labelledBy: { eventId: id, eventType: 'THEFT', labelledBy: reviewer } },
      create: { eventId: id, eventType: 'THEFT', label, labelledBy: reviewer, note },
      update: { label, note, labelledAt: now },
    })
    await tx.alertDecision.create({
      data: {
        organisationId: orgId, kind: 'FUEL', alertId: id, outcome,
        reason: outcome === 'ESCALATED' ? 'theft' : null, note, actorId: userId, at: now,
      },
    })
    const decided = await tx.fuelTheft.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, vehicleId: true, stolenMl: true, cleanDropMl: true, reviewStatus: true, reviewedAt: true, reviewNote: true,
        reviewedBy: { select: { fullName: true } },
        vehicle: { select: { registrationPlate: true } },
      },
    })
    return { ...decided, dismissedIds }
  })
}

/**
 * Take the unit's OTHER live alerts off the dashboard with the one just
 * cleared. The dashboard shows only a vehicle's newest open incident, so
 * clearing that one alone uncovers the next-newest on the same unit, which
 * reads as the alert coming straight back. Every other incident the dashboard
 * could still show for this vehicle (the snapshot's own filter: announced,
 * inside the window, after the epoch) goes with it. The rows are kept.
 *
 * Only the ones that began no later than it (`beganAt`), when given: deciding
 * an older alert from the Alerts page uncovers nothing, and must not take a
 * newer one off the map undecided.
 */
export async function sweepUnitSiblings(
  tx: Prisma.TransactionClient,
  args: { id: string; vehicleId: string; userId: string | null; now: Date; beganAt?: Date },
): Promise<string[]> {
  const { id, vehicleId, userId, now, beganAt } = args
  // The same set the map shows (telemetry incidentStaysOpen): the last 24 h,
  // plus every theft case still waiting for a review, however old — or
  // deciding the newest would put the next unreviewed one up in its place.
  const upTo = beganAt ? { lte: beganAt } : {}
  const recent = new Date(Math.max(now.getTime() - FUEL_INCIDENT_WINDOW_MS, FUEL_INCIDENT_EPOCH.getTime()))
  const siblings = await tx.fuelTheft.findMany({
    where: {
      vehicleId,
      id: { not: id },
      dismissedAt: null,
      OR: [
        { drainCause: { in: [...ANNOUNCED_CAUSES] }, beganAt: { gte: recent, ...upTo } },
        { drainCause: { in: [...ANNOUNCED_CAUSES] }, reviewStatus: null, beganAt: { gte: FUEL_INCIDENT_EPOCH, ...upTo } },
        { causeReason: { in: incidentReasonSlugs() }, beganAt: { gte: recent, ...upTo } },
      ],
    },
    select: { id: true },
  }) ?? []
  const siblingIds = siblings.map((r) => r.id)
  if (siblingIds.length > 0) {
    await tx.fuelTheft.updateMany({
      where: { id: { in: siblingIds }, dismissedAt: null },
      data: {
        dismissedAt: now, dismissedById: userId,
        reviewStatus: 'DISMISSED', reviewedAt: now, reviewedById: userId,
      },
    })
  }
  return siblingIds
}

/**
 * Mark one drain dismissed from the dashboard. Only a row that is not already
 * dismissed is touched, so the first person to dismiss it keeps the name and
 * the time against it. Returns the row either way (null if not in this org).
 */
/**
 * Dismiss a theft and open its follow-up, in one transaction: an incident is
 * never off the dashboard without a follow-up waiting on it (see
 * FuelTheftFollowUp). The first dismissal wins; a repeat returns it unchanged
 * with `followUpId` null, because nothing new was opened.
 */
export async function dismissTheft(orgId: string, id: string, userId: string | null) {
  const row = await prisma.fuelTheft.findFirst({
    where: { id, vehicle: { organisationId: orgId } },
    select: { id: true, vehicleId: true, dismissedAt: true },
  })
  if (!row) return null
  if (row.dismissedAt) return { ...row, followUpId: null, dismissedIds: [] as string[] }
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    // Conditional, so two people deleting the same alert at once open one
    // follow-up between them rather than one each.
    const { count } = await tx.fuelTheft.updateMany({
      where: { id, dismissedAt: null },
      data: {
        dismissedAt: now, dismissedById: userId,
        reviewStatus: 'DISMISSED', reviewedAt: now, reviewedById: userId,
      },
    })
    if (count === 0) {
      const won = await tx.fuelTheft.findUnique({ where: { id }, select: { id: true, vehicleId: true, dismissedAt: true } })
      return { ...(won ?? row), followUpId: null, dismissedIds: [] as string[] }
    }
    // Deleting an alert clears the UNIT, not just the one drain (see
    // sweepUnitSiblings). Only the clicked one opens a follow-up, since it is
    // the one somebody actually looked at.
    const siblingIds = await sweepUnitSiblings(tx, { id, vehicleId: row.vehicleId, userId, now })
    // The alert as the person deleting it saw it. Read inside the transaction,
    // so it is the row exactly as it stood at the moment of the deletion.
    const full = await tx.fuelTheft.findUnique({
      where: { id },
      include: {
        vehicle: { select: { registrationPlate: true, name: true } },
        driver: { select: { fullName: true } },
      },
    })
    const followUp = await tx.fuelTheftFollowUp.create({
      data: {
        organisationId: orgId, theftId: id, openedAt: now, dismissedById: userId,
        incidentSnapshot: full ? (JSON.parse(JSON.stringify(full)) as Prisma.InputJsonValue) : undefined,
        actions: { create: { kind: 'OPENED', actorId: userId, at: now } },
      },
      select: { id: true },
    })
    return {
      id: row.id, vehicleId: row.vehicleId, dismissedAt: now, followUpId: followUp.id as string | null,
      dismissedIds: siblingIds,
    }
  })
}

/** The rows `theftOutcomes` aggregates: one organisation, a `beganAt` window. */
export function theftOutcomeRows(orgId: string, from?: Date, to?: Date) {
  const dateFilter = buildDateFilter(from, to)
  return prisma.fuelTheft.findMany({
    where: { vehicle: { organisationId: orgId }, ...(dateFilter ? { beganAt: dateFilter } : {}) },
    select: {
      vehicleId: true, stolenMl: true, cleanDropMl: true, reviewStatus: true, dismissedAt: true, reviewedAt: true,
      vehicle: { select: { registrationPlate: true } },
    },
  })
}

export async function createTheft(dto: CreateTheftDto) {
  return prisma.fuelTheft.create({ data: dto })
}
