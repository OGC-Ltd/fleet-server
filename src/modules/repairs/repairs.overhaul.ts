/**
 * The overhaul audit on a repair job: what was inspected on the unit, and the
 * spare parts outsourced for the fix (RepairInspection, RepairSparePart).
 *
 * The job's stage follows its parts, so nobody has to move it by hand for the
 * part of the work the parts already describe:
 *
 *   first part ordered, job pending or fixing  ─▶ spare_outsourced
 *   every live part received or fitted         ─▶ fixing
 *
 * Collecting a part (received) needs the date the fix will happen. The job's
 * expectedResolutionAt is then the latest of those planned fix dates and the
 * promised dates of parts still on order: the day the unit can be back.
 *
 * and a job cannot be signed off FIXED while a part is still ordered, or
 * received and not fitted (assertNoOutstandingParts, called by closeItem).
 * Cancelled parts do not count either way. A FAILED sign-off is never
 * blocked: a unit that comes off the road does not wait on its spares.
 *
 * Every automatic move is written to the job's stage history with the reason,
 * the same ladder the Repairs tab and the Audit page draw.
 */

import { prisma } from '../../lib/prisma.js'
import type { Prisma } from '../../../generated/prisma/client.js'
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors/errors.js'
import { checklistFor } from './repairs.workflow.schema.js'
import { appendStage, type StageEvent } from './repairs.repository.js'
import type { Stage } from './repairs.schema.js'
import type { AddSparePart, SetInspection, UpdateSparePart } from './repairs.schema.js'
import type { IssuePart, SourcePart } from './repairs.workflow.schema.js'

/** Named but not yet fitted. 'requested' and 'issued' are the workflow's
 *  stores and ControlTech states (migration 20261020180000). */
const OUTSTANDING = ['requested', 'ordered', 'received', 'issued'] as const

/** Stages a part order moves to spare_outsourced: the job is being worked. */
const WORKING = ['pending', 'fixing', 'in_workshop', 'field_inspection'] as const

/** The overhaul record of some jobs, for the Audit page and the job's own read. */
export async function overhaulFor(itemIds: string[]) {
  if (itemIds.length === 0) return { parts: [], inspections: [] }
  const [parts, inspections] = await Promise.all([
    prisma.repairSparePart.findMany({ where: { repairItemId: { in: itemIds } }, orderBy: { orderedAt: 'asc' } }),
    prisma.repairInspection.findMany({ where: { repairItemId: { in: itemIds } }, orderBy: { inspectedAt: 'asc' } }),
  ])
  return { parts, inspections }
}

async function nameOf(tx: Prisma.TransactionClient, userId: string): Promise<string | null> {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } })
  return u?.fullName ?? null
}

/** The open job, in this organisation, or a 404 / 409 that says which. */
async function openJob(tx: Prisma.TransactionClient, itemId: string, orgId: string) {
  const job = await tx.repairReportItem.findFirst({
    where: { id: itemId, organisationId: orgId },
    select: { id: true, stage: true, resolvedAt: true, stageHistory: true, faultCategory: true },
  })
  if (!job) throw new NotFoundError('Repair job not found')
  if (job.resolvedAt) throw new ConflictError('This job has been signed off; its overhaul can no longer change')
  return job
}

/** Move the job, with the reason on its tracking line. Guarded on the stage it was read at. */
async function moveJob(
  tx: Prisma.TransactionClient,
  job: { id: string; stage: string; stageHistory: unknown },
  to: Stage, userId: string, byName: string | null, note: string,
) {
  if (job.stage === to) return
  const at = new Date()
  const event: StageEvent = { stage: to, at: at.toISOString(), by: userId, ...(byName ? { byName } : {}), note }
  await tx.repairReportItem.updateMany({
    where: { id: job.id, resolvedAt: null, stage: job.stage },
    data: { stage: to, stageChangedAt: at, stageHistory: appendStage(job.stageHistory, event) },
  })
}

/**
 * Keep the job's own summary fields in step with its live parts: the part
 * names (what the Repairs tab shows) and the day the unit can be back (what
 * its overdue sort reads): the latest of the planned fix dates of collected
 * parts and the promised dates of parts still on order.
 */
async function syncSummary(tx: Prisma.TransactionClient, itemId: string) {
  const live = await tx.repairSparePart.findMany({
    where: { repairItemId: itemId, status: { not: 'cancelled' } },
    select: { name: true, quantity: true, expectedAt: true, fixPlannedAt: true, status: true },
    orderBy: { orderedAt: 'asc' },
  })
  if (live.length === 0) return
  const names = live.map((p) => (p.quantity > 1 ? `${p.quantity} × ${p.name}` : p.name)).join(', ').slice(0, 200)
  const dates = live.flatMap((p) => (
    p.status === 'ordered' ? (p.expectedAt ? [p.expectedAt] : [])
      : p.status === 'received' && p.fixPlannedAt ? [p.fixPlannedAt] : []
  ))
  const latest = dates.reduce<Date | null>((m, d) => (!m || d > m ? d : m), null)
  await tx.repairReportItem.update({
    where: { id: itemId },
    data: { sparePart: names, ...(latest ? { expectedResolutionAt: latest } : {}) },
  })
}

/** Record one component's check. Overwrites the earlier check of it. */
export async function setInspection(orgId: string, itemId: string, userId: string, dto: SetInspection) {
  return prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    // The job's own checklist. 'other' has none, so any component goes.
    const list = checklistFor(job.faultCategory)
    if (list.length > 0 && !list.includes(dto.component)) {
      throw new UnprocessableError(`${dto.component} is not on this job's checklist`)
    }
    const byName = await nameOf(tx, userId)
    const data = {
      verdict: dto.verdict, note: dto.note?.trim() || null,
      inspectedById: userId, inspectedBy: byName, inspectedAt: new Date(),
    }
    return tx.repairInspection.upsert({
      where: { repairItemId_component: { repairItemId: itemId, component: dto.component } },
      create: { organisationId: orgId, repairItemId: itemId, component: dto.component, ...data },
      update: data,
    })
  })
}

/**
 * Order, request or issue a spare part for the job.
 *
 * No `source`: today's behaviour, the part is ordered and the first order
 * moves the job to spare_outsourced. With one (workflow step 5):
 *   inventory    in stock. A stores holder (`canIssue`) issues it at once;
 *                anyone else requests it from stores. The job does not wait.
 *   controltech  not in stock. Requested, for ControlTech to source; the job
 *                waits on it (spare_outsourced).
 */
export async function addSparePart(
  orgId: string, itemId: string, userId: string, dto: AddSparePart, canIssue = false,
) {
  return prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    const byName = await nameOf(tx, userId)
    const now = new Date()
    const status = !dto.source ? 'ordered'
      : dto.source === 'inventory' && canIssue ? 'issued'
        : 'requested'
    const part = await tx.repairSparePart.create({
      data: {
        organisationId: orgId, repairItemId: itemId,
        name: dto.name, quantity: dto.quantity, supplier: dto.supplier ?? null,
        costKes: dto.costKes ?? null, expectedAt: dto.expectedAt ?? null, note: dto.note ?? null,
        orderedById: userId, orderedBy: byName,
        status,
        source: dto.source ?? 'controltech',
        fsItemCode: dto.itemCode ?? null, fsStore: dto.store ?? null,
        ...(status === 'requested' ? { requestedAt: now } : {}),
        ...(status === 'issued' ? { issuedAt: now, issuedById: userId, issuedBy: byName } : {}),
      },
    })
    const waits = status === 'ordered' || (status === 'requested' && dto.source === 'controltech')
    if (waits && (WORKING as readonly string[]).includes(job.stage)) {
      const qty = dto.quantity > 1 ? `${dto.quantity} × ` : ''
      const what = status === 'ordered'
        ? `Spare ordered: ${qty}${dto.name}${dto.supplier ? ` from ${dto.supplier}` : ''}`
        : `Spare requested from ControlTech: ${qty}${dto.name}`
      await moveJob(tx, job, 'spare_outsourced', userId, byName, what)
    }
    await syncSummary(tx, itemId)
    return part
  })
}

const NEXT: Record<string, string[]> = {
  requested: ['ordered', 'issued', 'cancelled'],
  ordered:   ['received', 'cancelled'],
  received:  ['fitted', 'cancelled'],
  issued:    ['fitted', 'cancelled'],
  fitted:    [],
  cancelled: [],
}

/** Back to work once nothing the job waits on is still out. */
async function resumeIfAllIn(
  tx: Prisma.TransactionClient,
  job: { id: string; stage: string; stageHistory: unknown },
  userId: string, note: string,
) {
  const live = await tx.repairSparePart.findMany({
    where: { repairItemId: job.id, status: { not: 'cancelled' } }, select: { status: true },
  })
  const allIn = live.every((p) => p.status === 'received' || p.status === 'fitted' || p.status === 'issued')
  if (allIn && job.stage === 'spare_outsourced') {
    await moveJob(tx, job, 'fixing', userId, await nameOf(tx, userId), note)
  }
}

/** A requested part, by source, or a 404 / 409. */
async function requestedPart(
  tx: Prisma.TransactionClient, orgId: string, itemId: string, partId: string, source: 'inventory' | 'controltech',
) {
  const part = await tx.repairSparePart.findFirst({ where: { id: partId, repairItemId: itemId, organisationId: orgId } })
  if (!part) throw new NotFoundError('Spare part not found')
  if (part.status !== 'requested') throw new ConflictError(`This part is already ${part.status}`)
  if (part.source !== source) {
    throw new ConflictError(source === 'inventory'
      ? 'This part is being sourced by ControlTech, not issued from stores'
      : 'This part is to be issued from stores, not sourced by ControlTech')
  }
  return part
}

const appendNote = (prior: string | null, add?: string) =>
  add ? { note: prior ? `${prior}\n${add}` : add } : {}

/** ControlTech orders a requested part, or cancels the request. repair:parts_source. */
export async function sourcePart(orgId: string, itemId: string, partId: string, userId: string, dto: SourcePart) {
  return prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    const part = await requestedPart(tx, orgId, itemId, partId, 'controltech')
    const byName = await nameOf(tx, userId)
    const now = new Date()
    const { count } = await tx.repairSparePart.updateMany({
      where: { id: partId, status: 'requested' },
      data: dto.status === 'ordered'
        ? {
          status: 'ordered', orderedAt: now, orderedById: userId, orderedBy: byName,
          supplier: dto.supplier ?? part.supplier, orderRef: dto.orderRef ?? null,
          costKes: dto.costKes ?? part.costKes, expectedAt: dto.expectedAt ?? part.expectedAt,
          ...appendNote(part.note, dto.note),
        }
        : { status: 'cancelled', cancelledAt: now, ...appendNote(part.note, dto.note) },
    })
    if (count === 0) throw new ConflictError('This part changed while you were updating it. Reload and try again')
    if (dto.status === 'cancelled') await resumeIfAllIn(tx, job, userId, `Spare request cancelled: ${part.name}`)
    await syncSummary(tx, itemId)
    return tx.repairSparePart.findUniqueOrThrow({ where: { id: partId } })
  })
}

/**
 * Stores issue a requested part. repair:parts_issue. The RaiFactorySuite
 * stock read and issue write-back wait on the stores endpoint (plan §3.5,
 * Q7b); until then the issue is recorded here by hand with its reference.
 */
export async function issuePart(orgId: string, itemId: string, partId: string, userId: string, dto: IssuePart) {
  return prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    const part = await requestedPart(tx, orgId, itemId, partId, 'inventory')
    const byName = await nameOf(tx, userId)
    const { count } = await tx.repairSparePart.updateMany({
      where: { id: partId, status: 'requested' },
      data: {
        status: 'issued', issuedAt: new Date(), issuedById: userId, issuedBy: byName,
        fsStore: dto.store ?? part.fsStore, fsItemCode: dto.itemCode ?? part.fsItemCode,
        fsIssueId: dto.issueRef ?? null,
        ...appendNote(part.note, dto.note),
      },
    })
    if (count === 0) throw new ConflictError('This part changed while you were updating it. Reload and try again')
    await resumeIfAllIn(tx, job, userId, `Spare issued from stores: ${part.name}`)
    await syncSummary(tx, itemId)
    return tx.repairSparePart.findUniqueOrThrow({ where: { id: partId } })
  })
}

/** Move a part along ordered → received → fitted, or cancel it. */
export async function updateSparePart(orgId: string, itemId: string, partId: string, userId: string, dto: UpdateSparePart) {
  return prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    const part = await tx.repairSparePart.findFirst({ where: { id: partId, repairItemId: itemId, organisationId: orgId } })
    if (!part) throw new NotFoundError('Spare part not found')
    if (!NEXT[part.status]?.includes(dto.status)) {
      throw new ConflictError(`A part that is ${part.status} cannot be marked ${dto.status}`)
    }
    const now = new Date()
    const { count } = await tx.repairSparePart.updateMany({
      where: { id: partId, status: part.status },
      data: {
        status: dto.status,
        ...(dto.status === 'received' ? { receivedAt: now, fixPlannedAt: dto.fixDate } : {}),
        ...(dto.status === 'fitted' ? { fittedAt: now } : {}),
        ...(dto.status === 'cancelled' ? { cancelledAt: now } : {}),
        ...(dto.note ? { note: part.note ? `${part.note}\n${dto.note}` : dto.note } : {}),
      },
    })
    if (count === 0) throw new ConflictError('This part changed while you were updating it. Reload and try again')

    // Everything that is coming has come: the job is back to being worked.
    const planned = dto.fixDate ? `; fix planned for ${dto.fixDate.toISOString().slice(0, 10)}` : ''
    await resumeIfAllIn(tx, job, userId, `All spare parts received${planned}`)
    await syncSummary(tx, itemId)
    return tx.repairSparePart.findUniqueOrThrow({ where: { id: partId } })
  })
}

/**
 * Refuse a FIXED sign-off while a spare is outstanding: ordered, or received
 * and not yet fitted. Called before the write, like the sign-off authz check.
 */
export async function assertNoOutstandingParts(itemId: string, orgId: string) {
  const open = await prisma.repairSparePart.findMany({
    where: { repairItemId: itemId, organisationId: orgId, status: { in: [...OUTSTANDING] } },
    select: { name: true, status: true },
  })
  if (open.length === 0) return
  const why: Record<string, string> = {
    requested: 'not yet sourced', ordered: 'not received', received: 'not fitted', issued: 'not fitted',
  }
  const list = open.map((p) => `${p.name} (${why[p.status] ?? p.status})`).join(', ')
  throw new ConflictError(`This job cannot be signed off fixed while spare parts are outstanding: ${list}`)
}
