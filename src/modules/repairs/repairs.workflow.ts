/**
 * The Vehicle Support and Repair Workflow, on top of the repair job.
 * See docs/vehicle-support-repair-workflow-plan.md (§2 maps every step).
 *
 *   flag ─▶ forwarded (telematics: ControlTech queue) ─▶ claim ─▶ path
 *        └▶ awaiting_assessment (mechanical: straight to the workshop)
 *   remote ─▶ remote_fix ─▶ complete            physical ─▶ awaiting_assessment
 *   assessment: roadworthy ─▶ book (3 a day) ─▶ booked ─▶ arrive ─▶ in_workshop
 *               immobile   ─▶ towing ─▶ arrive  |  field_inspection (ticket at start)
 *   damage class ─▶ fixing (malicious opens a security investigation, never a gate)
 *   parts by source ─▶ work log ─▶ complete (tested) ─▶ completed
 *   Control Room verify: accept ─▶ fixed (Fuel Audit closes) | reject ─▶ fixing
 *
 * THE JOB STAYS THE ONE OBJECT. Every move here is a guarded update of
 * repair_report_items (`resolvedAt: null` and the stage it was read at in the
 * WHERE), written onto the same stageHistory trail the tracking line draws,
 * so a move that races another one matches nothing and is answered 409.
 *
 * Notifications go AFTER the transaction commits (repairs.workflow.notify),
 * and never undo a write.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../core/errors/errors.js'
import { appendStage, findItemById, type StageEvent } from './repairs.repository.js'
import { assertNoOutstandingParts } from './repairs.overhaul.js'
import { canReceiveTriage } from './repairs.authz.js'
import { repairSignedOff } from '../fuel/fuel-followup.service.js'
import { humanKind, STAGE_LABEL } from './repairs.service.js'
import { notifyWorkflow, roleHolderEmails, HEAD_OF_SECURITY_ROLE, type JobRef, type WorkflowEvent } from './repairs.workflow.notify.js'
import {
  checklistFor, queueFor, type Assessment, type Booking, type Complete, type Damage,
  type FaultCategory, type FlagUnits, type InvestigationUpdate, type PathBody, type Verify,
  type VoidBody, type WarrantyVoid, type WorkEntry, type WorkshopAssign,
} from './repairs.workflow.schema.js'
import type { Stage } from './repairs.schema.js'

type Tx = Prisma.TransactionClient
type Scope = Set<string> | null

export const CATEGORY_LABEL: Record<FaultCategory, string> = {
  fuel_probe: 'Fuel probe', tracker: 'Tracker', sensor: 'Sensor',
  engine: 'Engine', transmission: 'Transmission', brakes: 'Brakes',
  suspension_steering: 'Suspension and steering', tyres: 'Tyres',
  electrical: 'Electrical', hydraulics: 'Hydraulics', body: 'Body', other: 'Other',
}

/** Stages a job is being physically worked at, once it has a ticket. */
const WORKING: Stage[] = ['in_workshop', 'field_inspection', 'fixing', 'spare_outsourced']
/** Stages a technician may complete from. */
const COMPLETABLE: Stage[] = ['remote_fix', 'in_workshop', 'field_inspection', 'fixing']

const jobSelect = {
  id: true, organisationId: true, vehicleId: true, stage: true, stageHistory: true, resolvedAt: true,
  outcome: true, targetKind: true, faultKind: true, faultCategory: true, queue: true, path: true,
  ticketNo: true, assignedToId: true, assignmentStatus: true, workshopTechnicianId: true,
  damageClass: true, completedById: true,
  vehicle: { select: { registrationPlate: true } },
} as const
type Job = Prisma.RepairReportItemGetPayload<{ select: typeof jobSelect }>

function labelOf(job: Pick<Job, 'faultCategory' | 'faultKind'>): string {
  return job.faultCategory ? CATEGORY_LABEL[job.faultCategory as FaultCategory] ?? job.faultCategory : humanKind(job.faultKind)
}

function refOf(job: Job, stage: string = job.stage, ticketNo: string | null = job.ticketNo): JobRef {
  return {
    itemId: job.id, orgId: job.organisationId, vehicleId: job.vehicleId,
    plate: job.vehicle.registrationPlate, ticketNo, label: labelOf(job),
    stage: STAGE_LABEL[stage] ?? stage,
    assignedToId: job.assignedToId, workshopTechnicianId: job.workshopTechnicianId,
  }
}

async function nameOf(tx: Tx, userId: string): Promise<string | null> {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } })
  return u?.fullName ?? null
}

function assertInScope(scope: Scope, vehicleId: string) {
  if (scope && !scope.has(vehicleId)) throw new ForbiddenError('This unit is not one of the units assigned to you')
}

/** The open job, or a 404 / 409 that says which. */
async function openJob(tx: Tx, itemId: string, orgId: string): Promise<Job> {
  const job = await tx.repairReportItem.findFirst({ where: { id: itemId, organisationId: orgId }, select: jobSelect })
  if (!job) throw new NotFoundError('Repair job not found')
  if (job.resolvedAt) throw new ConflictError('This job is closed')
  return job
}

function assertStage(job: Job, allowed: Stage[], doing: string) {
  if (!allowed.includes(job.stage as Stage)) {
    throw new ConflictError(`A job that is ${STAGE_LABEL[job.stage] ?? job.stage} cannot be ${doing}`)
  }
}

/**
 * Move the job and record why, guarded on the stage it was read at. `data`
 * rides along in the same update, so the columns and the trail cannot disagree.
 */
async function move(
  tx: Tx, job: Job, to: Stage, userId: string, note: string | undefined,
  data: Prisma.RepairReportItemUncheckedUpdateManyInput = {},
) {
  const at = new Date()
  const byName = await nameOf(tx, userId)
  const event: StageEvent = {
    stage: to, at: at.toISOString(), by: userId, ...(byName ? { byName } : {}), ...(note ? { note } : {}),
  }
  const { count } = await tx.repairReportItem.updateMany({
    where: { id: job.id, resolvedAt: null, stage: job.stage },
    data: {
      ...data,
      ...(to !== job.stage ? { stage: to, stageChangedAt: at, stageHistory: appendStage(job.stageHistory, event) } : {}),
    },
  })
  if (count === 0) throw new ConflictError('This job changed while you were working on it. Reload and try again')
}

async function workEntry(tx: Tx, job: Job, userId: string, kind: WorkEntry['kind'], text: string, labourMinutes?: number) {
  return tx.repairWorkEntry.create({
    data: {
      organisationId: job.organisationId, repairItemId: job.id, byId: userId,
      byName: await nameOf(tx, userId), kind, text, ...(labourMinutes !== undefined ? { labourMinutes } : {}),
    },
  })
}

/** Notify, never throwing. */
async function tell(ref: JobRef, ev: WorkflowEvent) {
  try { await notifyWorkflow(ref, ev) } catch { /* see repairs.workflow.notify */ }
}

/** RT-YYYY-NNNNN from the sequence. Never reused, never edited. */
async function nextTicketNo(tx: Tx): Promise<string> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('repair_ticket_seq') AS n`
  return `RT-${new Date().getUTCFullYear()}-${String(row!.n).padStart(5, '0')}`
}

const day = (d: Date) => d.toISOString().slice(0, 10)
const utcDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
function addDays(d: Date, n: number) { return new Date(d.getTime() + n * 86_400_000) }
/**
 * Today as the workshop counts it: the calendar day in Nairobi, as a
 * midnight-UTC date like every DATE column here. From 21:00 UTC it is already
 * tomorrow there, and offering the day that has just ended would let a unit be
 * booked into a day nobody can drive it to. Never earlier than the UTC day, so
 * the booking schema's "not in the past" check still passes.
 */
function utcToday() {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${iso}T00:00:00.000Z`)
}

// ── 2 · Flag and forward ────────────────────────────────────────────────────

/** Where a flag of this category starts. */
function landing(category: FaultCategory, chosen: FlagUnits['queue'], forward: boolean) {
  if (!forward) return { stage: 'pending' as Stage, queue: null, path: null, forwardedAt: null }
  const queue = queueFor(category, chosen)
  return queue === 'controltech'
    ? { stage: 'forwarded' as Stage, queue, path: null, forwardedAt: new Date() }
    // Mechanical: ControlTech cannot fix a gearbox remotely, so there is no
    // remote decision to make. Straight to the Control Room's assessment.
    : { stage: 'awaiting_assessment' as Stage, queue, path: 'physical', forwardedAt: new Date() }
}

export async function flagUnits(orgId: string, userId: string, dto: FlagUnits, scope: Scope) {
  const vehicleIds = [...new Set(dto.vehicleIds)]
  const vehicles = await prisma.vehicle.findMany({
    where: { id: { in: vehicleIds }, organisationId: orgId }, select: { id: true, registrationPlate: true },
  })
  const stray = vehicleIds.find((id) => !vehicles.some((v) => v.id === id))
  if (stray) throw new NotFoundError(`Vehicle ${stray} is not in this organisation`)
  for (const v of vehicles) assertInScope(scope, v.id)

  // A probe flag is a probe job, so Fuel Audit and "Probe reported" see it.
  // Everything else is a fault on the unit, keyed by its category.
  const targetKind = dto.faultCategory === 'fuel_probe' ? 'probe' : 'unit'
  const open = await prisma.repairReportItem.findMany({
    where: {
      organisationId: orgId, vehicleId: { in: vehicleIds }, resolvedAt: null, targetKind,
      ...(targetKind === 'unit' ? { faultCategory: dto.faultCategory } : {}),
    },
    select: { vehicle: { select: { registrationPlate: true } } },
  })
  if (open.length > 0) {
    const plates = open.map((o) => o.vehicle.registrationPlate).join(', ')
    throw new ConflictError(`A ${CATEGORY_LABEL[dto.faultCategory].toLowerCase()} repair is already open for ${plates}`)
  }

  const land = landing(dto.faultCategory, dto.queue, dto.forward)
  const flaggedAt = new Date()
  const byName = await nameOf(prisma, userId)
  const note = land.stage === 'forwarded' ? 'Flagged and forwarded to ControlTech'
    : land.stage === 'awaiting_assessment' ? 'Flagged; mechanical fault, to the workshop for assessment'
      : 'Flagged'
  let report
  try {
    report = await prisma.repairReport.create({
      data: {
        organisationId: orgId, reportedById: userId, note: `Control Room flag: ${dto.suspectedFault}`,
        items: {
          create: vehicles.map((v) => ({
            organisationId: orgId, targetKind, vehicleId: v.id, outcome: 'flagged',
            faultCategory: dto.faultCategory, suspectedFault: dto.suspectedFault,
            problemNote: dto.suspectedFault,
            ...(dto.faultCategory === 'fuel_probe' ? { faultKind: 'fuel_probe_dead' } : {}),
            stage: land.stage, queue: land.queue, path: land.path, forwardedAt: land.forwardedAt,
            stageChangedAt: flaggedAt,
            stageHistory: [{
              stage: land.stage, at: flaggedAt.toISOString(), by: userId, ...(byName ? { byName } : {}), note,
            }] satisfies StageEvent[],
          })),
        },
      },
      include: { items: { select: jobSelect } },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new ConflictError('A repair is already open for one of these units')
    throw err
  }

  for (const job of report.items) {
    const ref = refOf(job)
    await tell(ref, {
      key: 'flagged', severity: 'warning',
      headline: land.queue === 'controltech' ? 'Unit flagged for ControlTech' : 'Unit flagged for repair',
      text: `flagged by ${byName ?? 'the Control Room'}: ${dto.suspectedFault}`,
      lines: [{ label: 'Suspected fault', value: dto.suspectedFault }, { label: 'Flagged by', value: byName ?? 'Control Room' }],
      audience: land.queue === 'controltech' ? ['control_room', 'controltech'] : ['control_room'],
    })
  }
  return Promise.all(report.items.map((i) => findItemById(i.id, orgId)))
}

/** Forward a job that is still pending: an unforwarded flag, or a Fuel Audit job. */
export async function forwardJob(orgId: string, itemId: string, userId: string, chosen?: 'controltech' | 'workshop') {
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertStage(job, ['pending'], 'forwarded')
    const category = (job.faultCategory ?? 'fuel_probe') as FaultCategory
    const land = landing(category, chosen, true)
    await move(tx, job, land.stage, userId, land.queue === 'controltech' ? 'Forwarded to ControlTech' : 'Forwarded to the workshop for assessment', {
      queue: land.queue, path: land.path, forwardedAt: land.forwardedAt,
      ...(job.faultCategory ? {} : { faultCategory: category }),
    })
    return { ...job, stage: land.stage, queue: land.queue }
  })
  await tell(refOf(job), {
    key: 'forwarded', severity: 'info', headline: 'Repair forwarded',
    text: job.queue === 'controltech' ? 'forwarded to ControlTech' : 'forwarded to the workshop for assessment',
    audience: job.queue === 'controltech' ? ['controltech'] : ['control_room'],
  })
  return findItemById(itemId, orgId)
}

/** The units a caller may flag: the Flag dialog's picker, within their scope. */
export async function flaggableUnits(orgId: string, scope: Scope) {
  return prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true, ...(scope ? { id: { in: [...scope] } } : {}) },
    select: { id: true, registrationPlate: true, name: true },
    orderBy: { registrationPlate: 'asc' },
  })
}

// ── 2 · The ControlTech queue ───────────────────────────────────────────────

export async function queue(orgId: string) {
  const rows = await prisma.repairReportItem.findMany({
    where: { organisationId: orgId, resolvedAt: null, queue: 'controltech', stage: { in: ['forwarded', 'remote_fix'] } },
    include: {
      vehicle: { select: { id: true, registrationPlate: true, name: true } },
      assignedTo: { select: { id: true, fullName: true } },
    },
    orderBy: { forwardedAt: 'asc' },
  })
  return rows
}

/** A ControlTech technician takes a job from the queue: a self-assignment, already accepted. */
export async function claim(orgId: string, itemId: string, userId: string) {
  const ok = await canReceiveTriage(userId, orgId)
  if (!ok.ok) throw new ForbiddenError('Only a technician of this organisation can claim a job')
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertStage(job, ['forwarded', 'pending'], 'claimed')
    if (job.assignedToId && job.assignedToId !== userId) throw new ConflictError('Someone else has already claimed this job')
    const at = new Date()
    const byName = await nameOf(tx, userId)
    const history = appendStage(appendStage(job.stageHistory, {
      kind: 'assignment', assignedToId: userId, ...(byName ? { assignedToName: byName } : {}),
      by: userId, ...(byName ? { byName } : {}), at: at.toISOString(), note: 'Claimed from the ControlTech queue',
    }), { kind: 'assignment_response', status: 'accepted', by: userId, ...(byName ? { byName } : {}), at: at.toISOString() })
    const { count } = await tx.repairReportItem.updateMany({
      where: { id: itemId, resolvedAt: null, stage: job.stage, OR: [{ assignedToId: null }, { assignedToId: userId }] },
      data: {
        assignedToId: userId, assignedById: userId, assignedAt: at, assignmentStatus: 'accepted',
        assignmentNote: 'Claimed from the ControlTech queue', stageHistory: history as Prisma.InputJsonValue,
      },
    })
    if (count === 0) throw new ConflictError('Someone else has just claimed this job')
    return { ...job, assignedToId: userId, byName }
  })
  await tell(refOf(job), {
    key: 'claimed', severity: 'info', headline: 'Repair claimed by ControlTech',
    text: `claimed by ${job.byName ?? 'a ControlTech technician'}`, audience: ['control_room'],
  })
  return findItemById(itemId, orgId)
}

/** Remote or physical: the claiming technician's call (telematics jobs). */
export async function decidePath(orgId: string, itemId: string, userId: string, dto: PathBody) {
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertStage(job, ['forwarded', 'pending', 'remote_fix'], 'sent that way')
    const to: Stage = dto.path === 'remote' ? 'remote_fix' : 'awaiting_assessment'
    const note = dto.path === 'remote'
      ? `Fixing remotely${dto.note ? `: ${dto.note}` : ''}`
      : `${job.stage === 'remote_fix' ? 'Remote fix not possible' : 'Physical inspection needed'}${dto.note ? `: ${dto.note}` : ''}`
    await move(tx, job, to, userId, note, {
      path: dto.path, pathNote: dto.note ?? null, pathDecidedById: userId, pathDecidedAt: new Date(),
    })
    return { ...job, to, note }
  })
  await tell(refOf(job, job.to), job.to === 'remote_fix'
    ? { key: 'path-remote', severity: 'info', headline: 'Fixing remotely', text: job.note, audience: ['control_room'] }
    : {
      key: 'path-physical', severity: 'warning', headline: 'Physical inspection needed: assess the unit',
      text: `${job.note}. Book a physical inspection`, audience: ['control_room'],
    })
  return findItemById(itemId, orgId)
}

// ── 3 · Assessment ──────────────────────────────────────────────────────────

export async function assess(orgId: string, itemId: string, userId: string, dto: Assessment, scope: Scope) {
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertInScope(scope, job.vehicleId)
    if (job.stage === 'booked') throw new ConflictError('Cancel the workshop booking before reassessing this unit')
    assertStage(job, ['awaiting_assessment', 'towing', 'field_inspection'], 'assessed')
    const byName = await nameOf(tx, userId)
    await tx.repairAssessment.create({
      data: {
        organisationId: orgId, repairItemId: itemId, roadworthy: dto.roadworthy, intervention: dto.intervention,
        reason: dto.reason ?? null, interventionDetail: (dto.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        assessedById: userId, assessedBy: byName,
      },
    })
    const to: Stage = dto.intervention === 'tow' ? 'towing'
      : dto.intervention === 'field_inspection' ? 'field_inspection' : 'awaiting_assessment'
    const note = dto.roadworthy ? 'Assessed roadworthy: book a workshop day'
      : `Not roadworthy (${dto.reason}); ${dto.intervention === 'tow' ? 'tow to the workshop' : 'inspect on site'}`
    // A field inspection is the visit itself, so it gets its ticket now (plan Q3a).
    const ticketNo = to === 'field_inspection' && !job.ticketNo ? await nextTicketNo(tx) : job.ticketNo
    await move(tx, { ...job, stage: job.stage }, to, userId, note, {
      path: 'physical',
      ...(ticketNo && ticketNo !== job.ticketNo ? { ticketNo, ticketIssuedAt: new Date() } : {}),
    })
    if (to === job.stage) {
      // Same stage (a reassessment that stays put): the trail still records it.
      const at = new Date()
      await tx.repairReportItem.update({
        where: { id: itemId },
        data: { stageHistory: appendStage(job.stageHistory, { stage: to, at: at.toISOString(), by: userId, ...(byName ? { byName } : {}), note }) },
      })
    }
    return { ...job, to, note, ticketNo, intervention: dto.intervention, reason: dto.reason }
  })
  const ref = refOf(job, job.to, job.ticketNo)
  await tell(ref, job.intervention === 'workshop'
    ? { key: 'assessed', severity: 'info', headline: 'Assessed roadworthy', text: job.note, audience: ['control_room'] }
    : {
      key: 'assessed', severity: 'warning',
      headline: job.intervention === 'tow' ? 'Unit not roadworthy: tow arranged' : 'Unit not roadworthy: field inspection',
      text: job.note, lines: [{ label: 'Reason', value: job.reason ?? '' }],
      audience: ['control_room', 'controltech', 'channel'],
    })
  return findItemById(itemId, orgId)
}

// ── 3A · Workshops, availability and booking (the 3-a-day cap) ──────────────

/** The organisation's workshops; one "Auto Workshop" is created on first use (plan Q5a). */
export async function workshops(orgId: string) {
  const rows = await prisma.workshop.findMany({ where: { organisationId: orgId, isActive: true }, orderBy: { name: 'asc' } })
  if (rows.length > 0) return rows
  return [await prisma.workshop.create({ data: { organisationId: orgId, name: 'Auto Workshop' } })]
}

async function workshopIn(orgId: string, workshopId: string, tx: Tx = prisma) {
  const w = await tx.workshop.findFirst({ where: { id: workshopId, organisationId: orgId, isActive: true } })
  if (!w) throw new NotFoundError('Workshop not found')
  return w
}

export async function updateWorkshop(orgId: string, workshopId: string, dto: { name?: string | undefined; dailyCapacity?: number | undefined; location?: string | undefined }) {
  await workshopIn(orgId, workshopId)
  return prisma.workshop.update({
    where: { id: workshopId },
    data: {
      ...(dto.name ? { name: dto.name } : {}),
      ...(dto.dailyCapacity !== undefined ? { dailyCapacity: dto.dailyCapacity } : {}),
      ...(dto.location !== undefined ? { location: dto.location || null } : {}),
    },
  })
}

const LIVE_BOOKING = ['booked', 'arrived']

async function bookedOn(tx: Tx, workshopId: string, date: Date) {
  return tx.workshopBooking.count({ where: { workshopId, bookingDate: date, status: { in: LIVE_BOOKING } } })
}

/** Free slots per day from today, for the booking picker. */
export async function availability(orgId: string, workshopId: string, days: number) {
  const w = await workshopIn(orgId, workshopId)
  const from = utcToday()
  const to = addDays(from, days)
  const rows = await prisma.workshopBooking.groupBy({
    by: ['bookingDate'],
    where: { workshopId, status: { in: LIVE_BOOKING }, bookingDate: { gte: from, lt: to } },
    _count: { _all: true },
  })
  const count = new Map(rows.map((r) => [day(r.bookingDate), r._count._all]))
  return {
    workshop: w,
    days: Array.from({ length: days }, (_, i) => {
      const d = day(addDays(from, i))
      const booked = count.get(d) ?? 0
      return { date: d, capacity: w.dailyCapacity, booked, free: Math.max(0, w.dailyCapacity - booked) }
    }),
  }
}

/** One workshop day: the booked units, and units that arrived without a booking (tows). */
export async function workshopDay(orgId: string, workshopId: string, iso: string) {
  const w = await workshopIn(orgId, workshopId)
  const date = utcDay(iso)
  const itemInclude = {
    vehicle: { select: { id: true, registrationPlate: true, name: true } },
    workshopTechnician: { select: { id: true, fullName: true } },
  } as const
  const [bookings, arrivals] = await Promise.all([
    prisma.workshopBooking.findMany({
      where: { workshopId, bookingDate: date, status: { not: 'cancelled' } },
      include: { repairItem: { include: itemInclude } },
      orderBy: { bookedAt: 'asc' },
    }),
    prisma.repairReportItem.findMany({
      where: {
        organisationId: orgId, ticketIssuedAt: { gte: date, lt: addDays(date, 1) },
        bookings: { none: { status: { in: LIVE_BOOKING } } },
      },
      include: itemInclude,
    }),
  ])
  const booked = bookings.filter((b) => LIVE_BOOKING.includes(b.status)).length
  return { workshop: w, date: iso, capacity: w.dailyCapacity, booked, bookings, unbookedArrivals: arrivals }
}

export async function book(orgId: string, itemId: string, userId: string, dto: Booking, scope: Scope) {
  const result = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertInScope(scope, job.vehicleId)
    assertStage(job, ['awaiting_assessment'], 'booked in')
    const last = await tx.repairAssessment.findFirst({ where: { repairItemId: itemId }, orderBy: { assessedAt: 'desc' } })
    if (!last) throw new ConflictError('Assess the unit before booking it: can it reach the workshop?')
    if (!last.roadworthy) throw new ConflictError('This unit was assessed as not roadworthy. Tow it or inspect it on site')
    const w = await workshopIn(orgId, dto.workshopId, tx)

    // Two bookings for the last slot of a day must not both succeed: the lock
    // serialises every booking for this workshop and day.
    const key = `${w.id}:${day(dto.date)}`
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${key}))`
    const taken = await bookedOn(tx, w.id, dto.date)
    if (taken >= w.dailyCapacity) {
      let next: string | null = null
      for (let i = 1; i <= 60 && !next; i++) {
        const d = addDays(dto.date, i)
        if (await bookedOn(tx, w.id, d) < w.dailyCapacity) next = day(d)
      }
      throw new ConflictError(`${w.name} is full on ${day(dto.date)} (${w.dailyCapacity} vehicles a day)${next ? `. The next free day is ${next}` : ''}`)
    }
    const byName = await nameOf(tx, userId)
    await tx.workshopBooking.create({
      data: {
        organisationId: orgId, workshopId: w.id, repairItemId: itemId, bookingDate: dto.date,
        bookedById: userId, bookedBy: byName,
      },
    })
    const note = `Booked into ${w.name} on ${day(dto.date)} (${taken + 1} of ${w.dailyCapacity})`
    await move(tx, job, 'booked', userId, note)
    return { job, note }
  })
  await tell(refOf(result.job, 'booked'), {
    key: 'booked', severity: 'info', headline: 'Workshop booked', text: result.note,
    audience: ['control_room', 'assignee'],
  })
  return findItemById(itemId, orgId)
}

export async function cancelBooking(orgId: string, itemId: string, userId: string, reason: string, scope: Scope) {
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertInScope(scope, job.vehicleId)
    assertStage(job, ['booked'], 'unbooked')
    const { count } = await tx.workshopBooking.updateMany({
      where: { repairItemId: itemId, status: 'booked' },
      data: { status: 'cancelled', cancelReason: reason, cancelledAt: new Date() },
    })
    if (count === 0) throw new ConflictError('This job has no live booking')
    await move(tx, job, 'awaiting_assessment', userId, `Booking cancelled: ${reason}`)
    return job
  })
  await tell(refOf(job, 'awaiting_assessment'), {
    key: 'booking-cancelled', severity: 'info', headline: 'Workshop booking cancelled', text: `booking cancelled: ${reason}`,
    audience: ['control_room'],
  })
  return findItemById(itemId, orgId)
}

// ── 4 · Arrival, ticket, workshop technician ────────────────────────────────

/** The unit is at the workshop: issue the ticket number. Idempotent. */
export async function arrive(orgId: string, itemId: string, userId: string, scope: Scope) {
  const result = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertInScope(scope, job.vehicleId)
    if (job.stage === 'in_workshop') return { job, ticketNo: job.ticketNo, already: true }
    assertStage(job, ['booked', 'towing'], 'checked in')
    const ticketNo = job.ticketNo ?? await nextTicketNo(tx)
    await tx.workshopBooking.updateMany({
      where: { repairItemId: itemId, status: 'booked' }, data: { status: 'arrived', arrivedAt: new Date() },
    })
    await move(tx, job, 'in_workshop', userId, `Arrived at the workshop; ticket ${ticketNo}`, {
      ticketNo, ...(job.ticketNo ? {} : { ticketIssuedAt: new Date() }),
    })
    return { job, ticketNo, already: false }
  })
  if (!result.already) {
    await tell(refOf(result.job, 'in_workshop', result.ticketNo), {
      key: 'arrived', severity: 'info', headline: 'Unit arrived at the workshop',
      text: `arrived; repair ticket ${result.ticketNo}`, audience: ['control_room', 'assignee', 'channel'],
    })
  }
  return findItemById(itemId, orgId)
}

export async function workshopAssign(orgId: string, itemId: string, userId: string, dto: WorkshopAssign) {
  if (dto.technicianId) {
    const ok = await canReceiveTriage(dto.technicianId, orgId)
    if (!ok.ok) throw new UnprocessableError('That person is not a technician of this organisation. Type their name instead')
  }
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    let name = dto.name?.trim() || null
    if (dto.technicianId) name = await nameOf(tx, dto.technicianId)
    await tx.repairReportItem.update({
      where: { id: itemId },
      data: { workshopTechnicianId: dto.technicianId ?? null, workshopTechnicianName: name },
    })
    await workEntry(tx, job, userId, 'note', `Workshop technician: ${name ?? 'unnamed'}`)
    return { ...job, workshopTechnicianId: dto.technicianId ?? null, name }
  })
  if (job.workshopTechnicianId) {
    await tell(refOf(job), {
      key: `ws-assign-${job.workshopTechnicianId}`, severity: 'info', headline: 'Workshop repair assigned to you',
      text: `workshop technician: ${job.name}`, audience: ['assignee'],
    })
  }
  return findItemById(itemId, orgId)
}

// ── 4 / 4.2 · Damage, security investigation, warranty void ─────────────────

export async function classifyDamage(orgId: string, itemId: string, userId: string, dto: Damage) {
  const result = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertStage(job, WORKING, 'classified')
    const at = new Date()
    const malicious = dto.damageClass === 'suspected_malicious'
    const data: Prisma.RepairReportItemUncheckedUpdateManyInput = {
      damageClass: dto.damageClass, damageNote: dto.note ?? null,
      damageClassifiedById: userId, damageClassifiedAt: at,
      ...(dto.diagnosis ? { diagnosis: dto.diagnosis } : {}),
      // Genuine damage voids nothing. The CHECK holds the same rule.
      ...(!malicious ? { warrantyVoid: false } : {}),
    }
    const to: Stage = job.stage === 'in_workshop' || job.stage === 'field_inspection' ? 'fixing' : job.stage as Stage
    const note = malicious ? `Suspected malicious damage: ${dto.note}` : 'Genuine damage; repair under way'
    await move(tx, job, to, userId, note, data)
    if (dto.diagnosis) await workEntry(tx, job, userId, 'diagnosis', dto.diagnosis)

    // The investigation is opened beside the repair and never gates it.
    let opened = false
    const existing = await tx.securityInvestigation.findUnique({ where: { repairItemId: itemId } })
    const byName = await nameOf(tx, userId)
    const entry = (status: string, n: string) => ({ status, at: at.toISOString(), by: userId, ...(byName ? { byName } : {}), note: n })
    if (malicious && !existing) {
      await tx.securityInvestigation.create({
        data: {
          organisationId: orgId, repairItemId: itemId, vehicleId: job.vehicleId, openedById: userId,
          history: [entry('open', `Opened from repair: ${dto.note}`)] as Prisma.InputJsonValue,
        },
      })
      opened = true
    } else if (!malicious && existing && !existing.closedAt) {
      await tx.securityInvestigation.update({
        where: { id: existing.id },
        data: {
          status: 'closed_unfounded', closedAt: at, closedById: userId,
          history: appendHistory(existing.history, entry('closed_unfounded', 'The workshop reclassified the damage as genuine')),
        },
      })
    }
    return { job, to, malicious, opened, note: dto.note }
  })
  if (result.malicious) {
    await tell(refOf(result.job, result.to), {
      key: 'malicious', severity: 'critical', headline: 'Suspected malicious damage',
      text: `suspected malicious damage: ${result.note}. Head of Security notified; the repair continues`,
      lines: [{ label: 'Damage', value: result.note ?? '' }, { label: 'Investigation', value: result.opened ? 'Opened' : 'Already open' }],
      audience: ['control_room', 'head_of_security'],
    })
  }
  return findItemById(itemId, orgId)
}

function appendHistory(history: unknown, entry: Record<string, unknown>): Prisma.InputJsonValue {
  const prior = Array.isArray(history) ? history : []
  return [...prior, entry].slice(-200) as Prisma.InputJsonValue
}

export async function voidWarranty(orgId: string, itemId: string, userId: string, dto: WarrantyVoid) {
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    if (job.damageClass !== 'suspected_malicious') {
      throw new ConflictError('A warranty is voided only for suspected malicious damage. Classify the damage first')
    }
    const list = checklistFor(job.faultCategory)
    const stray = dto.components.find((c) => list.length > 0 && !list.includes(c))
    if (stray) throw new UnprocessableError(`${stray} is not on this job's checklist`)
    await tx.repairReportItem.update({
      where: { id: itemId },
      data: {
        warrantyVoid: true, warrantyVoidNote: dto.note, warrantyVoidComponents: dto.components,
        warrantyVoidedById: userId, warrantyVoidedAt: new Date(),
      },
    })
    const what = dto.components.length ? dto.components.join(', ') : 'the whole unit'
    await workEntry(tx, job, userId, 'note', `Warranty marked void (${what}): ${dto.note}`)
    return { ...job, what }
  })
  await tell(refOf(job), {
    key: 'warranty-void', severity: 'warning', headline: 'Warranty marked void',
    text: `warranty void (${job.what}): ${dto.note}`, lines: [{ label: 'Components', value: job.what }],
    audience: ['control_room', 'head_of_security'],
  })
  return findItemById(itemId, orgId)
}

/** Security clears a void (plan Q6a: only Security, security_case:update). */
export async function clearWarranty(orgId: string, itemId: string, userId: string, note: string) {
  await prisma.$transaction(async (tx) => {
    const job = await tx.repairReportItem.findFirst({ where: { id: itemId, organisationId: orgId }, select: jobSelect })
    if (!job) throw new NotFoundError('Repair job not found')
    await tx.repairReportItem.update({ where: { id: itemId }, data: { warrantyVoid: false } })
    await workEntry(tx, job, userId, 'note', `Warranty void cleared by Security: ${note}`)
  })
  return findItemById(itemId, orgId)
}

// ── 6 · Work log, completion, verification ──────────────────────────────────

export async function addWork(orgId: string, itemId: string, userId: string, dto: WorkEntry) {
  return prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    return workEntry(tx, job, userId, dto.kind, dto.text, dto.labourMinutes)
  })
}

export async function complete(orgId: string, itemId: string, userId: string, dto: Complete) {
  const pre = await prisma.repairReportItem.findFirst({ where: { id: itemId, organisationId: orgId }, select: jobSelect })
  if (!pre) throw new NotFoundError('Repair job not found')
  if (pre.resolvedAt) throw new ConflictError('This job is closed')
  if (pre.stage === 'spare_outsourced') throw new ConflictError('This job is still waiting on spare parts')
  assertStage(pre, COMPLETABLE, 'completed')
  // A workshop or field job is classified before it is closed (rule 4); a remote fix has nothing to classify.
  if (pre.ticketNo && !pre.damageClass) throw new UnprocessableError('Classify the damage (genuine or suspected malicious) before completing')
  await assertNoOutstandingParts(itemId, orgId)

  const result = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    if (dto.testResult === 'fail') {
      await workEntry(tx, job, userId, 'test', `Test failed${dto.testNote ? `: ${dto.testNote}` : ''}`)
      return { job, failed: true }
    }
    await workEntry(tx, job, userId, 'test', `Test passed${dto.testNote ? `: ${dto.testNote}` : ''}`)
    await move(tx, job, 'completed', userId, `Completed and tested: ${dto.fixNote}`, {
      completedAt: new Date(), completedById: userId, testResult: 'pass', testNote: dto.testNote ?? null,
      fixNote: dto.fixNote, ...(dto.recommendation ? { recommendation: dto.recommendation } : {}),
    })
    return { job, failed: false }
  })
  if (!result.failed) {
    await tell(refOf(result.job, 'completed'), {
      key: 'completed', severity: 'warning', headline: 'Repair completed: verify it',
      text: `completed and tested, awaiting the Control Room: ${dto.fixNote}`,
      lines: [{ label: 'What was done', value: dto.fixNote }],
      audience: ['control_room', 'channel'],
    })
  }
  const item = await findItemById(itemId, orgId)
  return { item, testFailed: result.failed }
}

export async function verify(orgId: string, itemId: string, userId: string, dto: Verify, scope: Scope) {
  const result = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    assertInScope(scope, job.vehicleId)
    assertStage(job, ['completed'], 'verified')
    if (job.completedById === userId) throw new ForbiddenError('A repair is verified by someone other than the person who completed it')
    const at = new Date()
    if (dto.decision === 'accept') {
      await move(tx, job, 'fixed', userId, `Verified by the Control Room${dto.note ? `: ${dto.note}` : ''}`, {
        verifiedAt: at, verifiedById: userId, verifyNote: dto.note ?? null,
        resolvedAt: at, resolvedById: job.completedById ?? userId,
      })
    } else {
      await move(tx, job, 'fixing', userId, `Verification rejected: ${dto.note}`, {
        verifyNote: dto.note ?? null, completedAt: null, completedById: null, testResult: null,
      })
    }
    return job
  })
  // The existing sign-off chain: Fuel Audit cases close, "Probe reported" lifts.
  if (dto.decision === 'accept') await repairSignedOff(orgId, itemId)
  await tell(refOf(result, dto.decision === 'accept' ? 'fixed' : 'fixing'), dto.decision === 'accept'
    ? {
      key: 'verified', severity: 'info', headline: 'Repair verified: unit available',
      text: 'verified by the Control Room; the unit is fixed and available', audience: ['control_room', 'assignee', 'channel'],
    }
    : {
      key: 'verify-rejected', severity: 'warning', headline: 'Repair verification rejected',
      text: `verification rejected: ${dto.note}`, lines: [{ label: 'Reason', value: dto.note ?? '' }],
      audience: ['control_room', 'assignee'],
    })
  return findItemById(itemId, orgId)
}

export async function voidJob(orgId: string, itemId: string, userId: string, dto: VoidBody) {
  const job = await prisma.$transaction(async (tx) => {
    const job = await openJob(tx, itemId, orgId)
    if (dto.precededById) {
      const other = await tx.repairReportItem.findFirst({ where: { id: dto.precededById, organisationId: orgId }, select: { id: true } })
      if (!other || other.id === itemId) throw new UnprocessableError('The job this duplicates was not found')
    }
    await tx.workshopBooking.updateMany({
      where: { repairItemId: itemId, status: 'booked' },
      data: { status: 'cancelled', cancelReason: `Job void: ${dto.reason}`, cancelledAt: new Date() },
    })
    await move(tx, job, 'void', userId, `Void: ${dto.reason}`, {
      voidReason: dto.reason, resolvedAt: new Date(), resolvedById: userId,
      ...(dto.precededById ? { precededById: dto.precededById } : {}),
    })
    return job
  })
  await tell(refOf(job, 'void'), {
    key: 'void', severity: 'info', headline: 'Repair job void', text: `void: ${dto.reason}`, audience: ['control_room'],
  })
  return findItemById(itemId, orgId)
}

// ── 7 · The ticket, and the unit's service state ────────────────────────────

export async function ticket(orgId: string, itemId: string) {
  const item = await prisma.repairReportItem.findFirst({
    where: { id: itemId, organisationId: orgId },
    include: {
      vehicle: { select: { id: true, registrationPlate: true, name: true } },
      assignedTo: { select: { id: true, fullName: true } },
      workshopTechnician: { select: { id: true, fullName: true } },
      resolvedBy: { select: { id: true, fullName: true } },
      report: { select: { id: true, reportedAt: true, reportedBy: { select: { fullName: true } } } },
      assessments: { orderBy: { assessedAt: 'asc' } },
      bookings: { include: { workshop: { select: { id: true, name: true } } }, orderBy: { bookedAt: 'asc' } },
      spareParts: { orderBy: { orderedAt: 'asc' } },
      inspections: { orderBy: { inspectedAt: 'asc' } },
      workEntries: { orderBy: { at: 'asc' } },
      securityInvestigation: { select: { id: true, status: true, openedAt: true, closedAt: true } },
    },
  })
  if (!item) throw new NotFoundError('Repair job not found')
  const people = await prisma.user.findMany({
    where: { id: { in: [item.completedById, item.verifiedById, item.pathDecidedById, item.damageClassifiedById].filter((x): x is string => !!x) } },
    select: { id: true, fullName: true },
  })
  const nameFor = (id: string | null) => people.find((p) => p.id === id)?.fullName ?? null
  return {
    ...item,
    checklist: checklistFor(item.faultCategory),
    completedByName: nameFor(item.completedById),
    verifiedByName: nameFor(item.verifiedById),
    pathDecidedByName: nameFor(item.pathDecidedById),
    damageClassifiedByName: nameFor(item.damageClassifiedById),
  }
}

export type ServiceState = 'in_workshop' | 'awaiting_repair' | 'awaiting_verification'
const RANK: Record<ServiceState, number> = { awaiting_repair: 1, in_workshop: 2, awaiting_verification: 3 }

function stateOf(stage: string): ServiceState {
  if (stage === 'completed') return 'awaiting_verification'
  if ((WORKING as string[]).includes(stage)) return 'in_workshop'
  return 'awaiting_repair'
}

/** Per unit with an open job: the most advanced state (plan §3.7). Derived, never written to vehicles.status. */
export async function serviceStates(orgId: string, scope: Scope) {
  const rows = await prisma.repairReportItem.findMany({
    where: { organisationId: orgId, resolvedAt: null, ...(scope ? { vehicleId: { in: [...scope] } } : {}) },
    select: { id: true, vehicleId: true, stage: true, ticketNo: true, faultCategory: true, faultKind: true },
  })
  const out = new Map<string, { vehicleId: string; state: ServiceState; itemId: string; stage: string; ticketNo: string | null; label: string; jobs: number }>()
  for (const r of rows) {
    const state = stateOf(r.stage)
    const prev = out.get(r.vehicleId)
    const jobs = (prev?.jobs ?? 0) + 1
    if (!prev || RANK[state] > RANK[prev.state]) {
      out.set(r.vehicleId, { vehicleId: r.vehicleId, state, itemId: r.id, stage: r.stage, ticketNo: r.ticketNo, label: labelOf(r), jobs })
    } else prev.jobs = jobs
  }
  return [...out.values()]
}

// ── 4.2 · Security investigations (Head of Security) ────────────────────────

export async function investigations(orgId: string, status?: 'open' | 'closed' | 'all') {
  return prisma.securityInvestigation.findMany({
    where: {
      organisationId: orgId,
      ...(status === 'open' ? { closedAt: null } : status === 'closed' ? { closedAt: { not: null } } : {}),
    },
    include: {
      vehicle: { select: { id: true, registrationPlate: true, name: true } },
      assignedTo: { select: { id: true, fullName: true } },
      repairItem: {
        select: {
          id: true, ticketNo: true, stage: true, faultCategory: true, faultKind: true, suspectedFault: true,
          damageNote: true, damageClassifiedAt: true, diagnosis: true,
          warrantyVoid: true, warrantyVoidNote: true, warrantyVoidComponents: true,
          workshopTechnicianName: true,
        },
      },
    },
    orderBy: { openedAt: 'desc' },
  })
}

export async function updateInvestigation(orgId: string, id: string, userId: string, dto: InvestigationUpdate) {
  const inv = await prisma.securityInvestigation.findFirst({ where: { id, organisationId: orgId } })
  if (!inv) throw new NotFoundError('Investigation not found')
  if (dto.assignedToId) {
    const holders = await prisma.userRole.count({
      where: { userId: dto.assignedToId, revokedAt: null, role: { slug: HEAD_OF_SECURITY_ROLE, organisationId: orgId } },
    })
    if (holders === 0) throw new UnprocessableError('An investigation is held by a Head of Security of this organisation')
  }
  const at = new Date()
  const byName = await nameOf(prisma, userId)
  const closing = dto.status === 'closed_confirmed' || dto.status === 'closed_unfounded'
  const status = dto.status ?? inv.status
  const note = [dto.note, dto.findings && dto.findings !== inv.findings ? 'Findings updated' : null].filter(Boolean).join('. ')
  return prisma.securityInvestigation.update({
    where: { id },
    data: {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.findings !== undefined ? { findings: dto.findings } : {}),
      ...(dto.assignedToId !== undefined ? { assignedToId: dto.assignedToId } : {}),
      ...(closing ? { closedAt: at, closedById: userId } : dto.status ? { closedAt: null, closedById: null } : {}),
      history: appendHistory(inv.history, { status, at: at.toISOString(), by: userId, ...(byName ? { byName } : {}), ...(note ? { note } : {}) }),
    },
    include: { vehicle: { select: { id: true, registrationPlate: true, name: true } }, assignedTo: { select: { id: true, fullName: true } } },
  })
}

/** The Heads of Security an investigation can be handed to. */
export async function securityHolders(orgId: string) {
  return prisma.user.findMany({
    where: {
      deletedAt: null, status: { notIn: ['SUSPENDED', 'TERMINATED'] },
      userRoles: { some: { revokedAt: null, role: { slug: HEAD_OF_SECURITY_ROLE, organisationId: orgId } } },
    },
    select: { id: true, fullName: true, email: true },
    orderBy: { fullName: 'asc' },
  })
}

// ── The daily chases (plan §6, sweep additions) ─────────────────────────────

/** Days an investigation may stay open before it is chased. */
const INVESTIGATION_STALE_DAYS = 14

/**
 * Called from the repair sweep. Booked units whose day passed without arrival
 * become no-shows and go back for rebooking; completed repairs nobody verified
 * and queue jobs nobody claimed are chased once a day (the feed id carries the
 * day). Investigations are chased but never touch the job.
 */
export async function workflowSweep(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const stamp = day(today)

  const missed = await prisma.workshopBooking.findMany({
    where: { status: 'booked', bookingDate: { lt: today } },
    select: { id: true, bookingDate: true, repairItemId: true, organisationId: true },
  })
  for (const b of missed) {
    try {
      const job = await prisma.$transaction(async (tx) => {
        const { count } = await tx.workshopBooking.updateMany({ where: { id: b.id, status: 'booked' }, data: { status: 'no_show' } })
        if (count === 0) return null
        const job = await tx.repairReportItem.findFirst({ where: { id: b.repairItemId, resolvedAt: null }, select: jobSelect })
        if (!job || job.stage !== 'booked') return job
        const at = new Date()
        await tx.repairReportItem.updateMany({
          where: { id: job.id, resolvedAt: null, stage: 'booked' },
          data: {
            stage: 'awaiting_assessment', stageChangedAt: at,
            stageHistory: appendStage(job.stageHistory, {
              stage: 'awaiting_assessment', at: at.toISOString(), by: null,
              note: `Did not arrive on ${day(b.bookingDate)}: rebook it`,
            }),
          },
        })
        return job
      })
      if (job) {
        await tell(refOf(job, 'awaiting_assessment'), {
          key: `no-show-${day(b.bookingDate)}`, severity: 'warning', headline: 'Booked unit did not arrive',
          text: `did not arrive on its workshop day ${day(b.bookingDate)}; rebook it`, audience: ['control_room'],
        })
      }
    } catch { /* the next run picks it up */ }
  }

  const staleCompleted = await prisma.repairReportItem.findMany({
    where: {
      resolvedAt: null, stage: 'completed',
      completedAt: { lt: new Date(now.getTime() - env.REPAIR_VERIFY_STALE_HOURS * 3_600_000) },
    },
    select: jobSelect,
  })
  for (const job of staleCompleted) {
    await tell(refOf(job), {
      key: `verify-stale-${stamp}`, severity: 'warning', headline: 'Completed repair waiting for verification',
      text: `completed more than ${env.REPAIR_VERIFY_STALE_HOURS} h ago and not yet verified`, audience: ['control_room'],
    })
  }

  const unclaimed = await prisma.repairReportItem.findMany({
    where: {
      resolvedAt: null, stage: 'forwarded', queue: 'controltech', assignedToId: null,
      forwardedAt: { lt: new Date(now.getTime() - 86_400_000) },
    },
    select: jobSelect,
  })
  for (const job of unclaimed) {
    await tell(refOf(job), {
      key: `unclaimed-${stamp}`, severity: 'warning', headline: 'Repair unclaimed in the ControlTech queue',
      text: 'forwarded more than a day ago and not yet claimed', audience: ['controltech', 'control_room'],
    })
  }

  const oldCases = await prisma.securityInvestigation.findMany({
    where: { closedAt: null, openedAt: { lt: new Date(now.getTime() - INVESTIGATION_STALE_DAYS * 86_400_000) } },
    include: { repairItem: { select: jobSelect } },
  })
  for (const c of oldCases) {
    await tell(refOf(c.repairItem), {
      key: `investigation-stale-${stamp}`, severity: 'warning', headline: 'Security investigation still open',
      text: `security investigation open more than ${INVESTIGATION_STALE_DAYS} days`, audience: ['head_of_security'],
    })
  }

  logger.info({ noShows: missed.length, unverified: staleCompleted.length, unclaimed: unclaimed.length, investigations: oldCases.length }, 'repair sweep: workflow checks done')
}

export { roleHolderEmails }
