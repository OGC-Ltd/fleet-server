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
import { ConflictError, NotFoundError } from '../../core/errors/errors.js'
import { appendStage, type StageEvent } from './repairs.repository.js'
import type { Stage } from './repairs.schema.js'
import type { AddSparePart, SetInspection, UpdateSparePart } from './repairs.schema.js'

const OUTSTANDING = ['ordered', 'received'] as const

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
    select: { id: true, stage: true, resolvedAt: true, stageHistory: true },
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
 * names (what the Repairs tab shows) and the latest promised date (what its
 * overdue sort reads).
 */
async function syncSummary(tx: Prisma.TransactionClient, itemId: string) {
  const live = await tx.repairSparePart.findMany({
    where: { repairItemId: itemId, status: { not: 'cancelled' } },
    select: { name: true, quantity: true, expectedAt: true, status: true },
    orderBy: { orderedAt: 'asc' },
  })
  if (live.length === 0) return
  const names = live.map((p) => (p.quantity > 1 ? `${p.quantity} × ${p.name}` : p.name)).join(', ').slice(0, 200)
  const waiting = live.filter((p) => p.status === 'ordered' && p.expectedAt)
  const latest = waiting.reduce<Date | null>((m, p) => (!m || p.expectedAt! > m ? p.expectedAt! : m), null)
  await tx.repairReportItem.update({
    where: { id: itemId },
    data: { sparePart: names, ...(latest ? { expectedResolutionAt: latest } : {}) },
  })
}

/** Record one component's check. Overwrites the earlier check of it. */
export async function setInspection(orgId: string, itemId: string, userId: string, dto: SetInspection) {
  return prisma.$transaction(async (tx) => {
    await openJob(tx, itemId, orgId)
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

/** Order a spare part for the job. The first order moves the job to spare_outsourced. */
export async function addSparePart(orgId: string, itemId: string, userId: string, dto: AddSparePart) {
  return prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    const byName = await nameOf(tx, userId)
    const part = await tx.repairSparePart.create({
      data: {
        organisationId: orgId, repairItemId: itemId,
        name: dto.name, quantity: dto.quantity, supplier: dto.supplier ?? null,
        costKes: dto.costKes ?? null, expectedAt: dto.expectedAt ?? null, note: dto.note ?? null,
        orderedById: userId, orderedBy: byName,
      },
    })
    if (job.stage === 'pending' || job.stage === 'fixing') {
      const from = dto.supplier ? ` from ${dto.supplier}` : ''
      await moveJob(tx, job, 'spare_outsourced', userId, byName, `Spare ordered: ${dto.quantity > 1 ? `${dto.quantity} × ` : ''}${dto.name}${from}`)
    }
    await syncSummary(tx, itemId)
    return part
  })
}

const NEXT: Record<string, string[]> = {
  ordered:  ['received', 'cancelled'],
  received: ['fitted', 'cancelled'],
  fitted:   [],
  cancelled: [],
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
        ...(dto.status === 'received' ? { receivedAt: now } : {}),
        ...(dto.status === 'fitted' ? { fittedAt: now } : {}),
        ...(dto.status === 'cancelled' ? { cancelledAt: now } : {}),
        ...(dto.note ? { note: part.note ? `${part.note}\n${dto.note}` : dto.note } : {}),
      },
    })
    if (count === 0) throw new ConflictError('This part changed while you were updating it. Reload and try again')

    // Everything that is coming has come: the job is back to being worked.
    const live = await tx.repairSparePart.findMany({
      where: { repairItemId: itemId, status: { not: 'cancelled' } }, select: { status: true },
    })
    const allIn = live.length > 0 && live.every((p) => p.status === 'received' || p.status === 'fitted')
    if (allIn && job.stage === 'spare_outsourced') {
      await moveJob(tx, job, 'fixing', userId, await nameOf(tx, userId), 'All spare parts received')
    }
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
  const list = open.map((p) => `${p.name} (${p.status === 'ordered' ? 'not received' : 'not fitted'})`).join(', ')
  throw new ConflictError(`This job cannot be signed off fixed while spare parts are outstanding: ${list}`)
}
