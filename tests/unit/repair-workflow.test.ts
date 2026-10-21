/**
 * The Vehicle Support and Repair Workflow's rules, pinned
 * (docs/vehicle-support-repair-workflow-plan.md).
 *
 *   - telematics faults go to the ControlTech queue, mechanical ones straight
 *     to the workshop for assessment;
 *   - an immobile unit is always assessed with a reason;
 *   - the workshop takes at most 3 booked vehicles a day, and a full day
 *     names the next free one;
 *   - a repair is verified by someone other than the person who completed it;
 *   - a workshop job is classified before it is completed;
 *   - a security investigation never gates the repair;
 *   - the Control Room is supervisor, fleet analyst and operator, and only the
 *     supervisor of the three assesses and verifies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = vi.hoisted(() => ({
  repairReportItem:   { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  repairAssessment:   { findFirst: vi.fn(), create: vi.fn() },
  workshop:           { findFirst: vi.fn() },
  workshopBooking:    { count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  securityInvestigation: { findMany: vi.fn() },
  repairSparePart:    { findMany: vi.fn() },
  repairWorkEntry:    { create: vi.fn() },
  user:               { findUnique: vi.fn() },
  $queryRaw:          vi.fn(),
}))
const prismaMock = vi.hoisted(() => ({
  ...tx,
  $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
}))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))
vi.mock('../../src/modules/fuel/fuel-followup.service.js', () => ({ repairSignedOff: vi.fn() }))
vi.mock('../../src/modules/repairs/repairs.workflow.notify.js', () => ({
  notifyWorkflow: vi.fn(async () => ({ to: [], accepted: [] })),
  roleHolderEmails: vi.fn(async () => []),
  HEAD_OF_SECURITY_ROLE: 'head_of_security',
}))

import { assessmentSchema, checklistFor, flagUnitsSchema, queueFor, spotFixSchema, CHECKLISTS } from '../../src/modules/repairs/repairs.workflow.schema.js'
import { book, complete, flagUnits, verify, workflowSweep } from '../../src/modules/repairs/repairs.workflow.js'
import { ROLE_DEFINITIONS } from '../../src/lib/permissions.js'
import { ConflictError, ForbiddenError, UnprocessableError } from '../../src/core/errors/errors.js'

const ORG = 'org-1'

function job(over: Record<string, unknown> = {}) {
  return {
    id: 'job-1', organisationId: ORG, vehicleId: 'v-1', stage: 'awaiting_assessment', stageHistory: [],
    resolvedAt: null, outcome: 'flagged', targetKind: 'unit', faultKind: null, faultCategory: 'brakes',
    queue: 'workshop', path: 'physical', ticketNo: null, assignedToId: null, assignmentStatus: 'accepted',
    workshopTechnicianId: null, damageClass: null, completedById: null,
    vehicle: { registrationPlate: 'KDA 001A' },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tx.user.findUnique.mockResolvedValue({ fullName: 'Pat Doe' })
  tx.repairReportItem.updateMany.mockResolvedValue({ count: 1 })
  tx.repairSparePart.findMany.mockResolvedValue([])
  tx.repairWorkEntry.create.mockResolvedValue({})
  tx.$queryRaw.mockResolvedValue([{ ok: 1 }])
})

describe('routing by fault category', () => {
  it('sends telematics faults to the ControlTech queue', () => {
    for (const c of ['fuel_probe', 'tracker', 'gps', 'ignition', 'sensor'] as const) expect(queueFor(c)).toBe('controltech')
  })

  it('sends mechanical faults to the workshop', () => {
    for (const c of ['engine', 'transmission', 'brakes', 'tyres', 'hydraulics'] as const) expect(queueFor(c)).toBe('workshop')
  })

  it('lets the flagger route "other", defaulting to the workshop', () => {
    expect(queueFor('other', 'controltech')).toBe('controltech')
    expect(queueFor('other')).toBe('workshop')
  })

  it('keeps the five probe components every existing inspection row uses', () => {
    expect(CHECKLISTS.fuel_probe).toEqual(['probe', 'probe_cable', 'tank_bracket', 'tracker', 'calibration'])
    // A job from before the workflow has no category and is a probe job.
    expect(checklistFor(null)).toEqual(CHECKLISTS.fuel_probe)
  })
})

describe('one flag, several faults (2026-10-22)', () => {
  it('takes a list of categories across groups, deduplicated', () => {
    const b = flagUnitsSchema.parse({ vehicleIds: ['v1'], faultCategories: ['gps', 'brakes', 'gps'], suspectedFault: 'x' })
    expect(b.faultCategories).toEqual(['gps', 'brakes'])
  })

  it('still reads the single faultCategory an older client sends', () => {
    expect(flagUnitsSchema.parse({ vehicleIds: ['v1'], faultCategory: 'ignition', suspectedFault: 'x' }).faultCategories).toEqual(['ignition'])
  })

  it('refuses a flag that names no fault', () => {
    expect(() => flagUnitsSchema.parse({ vehicleIds: ['v1'], suspectedFault: 'x' })).toThrow()
    expect(() => flagUnitsSchema.parse({ vehicleIds: ['v1'], faultCategories: [], suspectedFault: 'x' })).toThrow()
  })

  it('makes one job per unit per category, each routed by its own category', async () => {
    const create = vi.fn(async ({ data }: { data: { items: { create: Array<Record<string, unknown>> } } }) => ({
      items: data.items.create.map((it, i) => ({ id: `j${i}`, ...it })),
    }))
    const extra = prismaMock as unknown as Record<string, unknown>
    extra.vehicle = { findMany: vi.fn(async () => [{ id: 'v1', registrationPlate: 'KBL 126W' }, { id: 'v2', registrationPlate: 'KDJ 820Z' }]) }
    extra.repairReport = { create }
    tx.repairReportItem.findMany.mockResolvedValueOnce([])
    tx.repairReportItem.findFirst.mockResolvedValue(null)
    tx.user.findUnique.mockResolvedValue({ name: 'Control Room' })

    await flagUnits(ORG, 'u1', flagUnitsSchema.parse({
      vehicleIds: ['v1', 'v2'], faultCategories: ['gps', 'ignition', 'brakes'], suspectedFault: 'No fix since 13:54',
    }), null).catch(() => undefined)

    const items = create.mock.calls[0][0].data.items.create
    expect(items).toHaveLength(6)
    const of = (v: string, c: string) => items.find((i) => i.vehicleId === v && i.faultCategory === c)
    expect(of('v1', 'gps')).toMatchObject({ targetKind: 'unit', queue: 'controltech', stage: 'forwarded' })
    expect(of('v2', 'ignition')).toMatchObject({ queue: 'controltech' })
    expect(of('v1', 'brakes')).toMatchObject({ queue: 'workshop', stage: 'awaiting_assessment', path: 'physical' })
  })

  it('refuses the whole flag when any of its faults is already open, naming it', async () => {
    const extra = prismaMock as unknown as Record<string, unknown>
    extra.vehicle = { findMany: vi.fn(async () => [{ id: 'v1', registrationPlate: 'KBL 126W' }]) }
    tx.repairReportItem.findMany.mockResolvedValueOnce([{ targetKind: 'unit', faultCategory: 'gps', vehicle: { registrationPlate: 'KBL 126W' } }])
    await expect(flagUnits(ORG, 'u1', flagUnitsSchema.parse({
      vehicleIds: ['v1'], faultCategories: ['gps', 'brakes'], suspectedFault: 'x',
    }), null)).rejects.toThrow('A gps repair is already open for KBL 126W')
  })

  it('gives GPS and ignition their own checklists', () => {
    expect(CHECKLISTS.gps.length).toBeGreaterThan(0)
    expect(CHECKLISTS.ignition.length).toBeGreaterThan(0)
  })
})

describe('assessing a unit', () => {
  it('demands a reason when the unit cannot reach the workshop', () => {
    const r = assessmentSchema.safeParse({ roadworthy: false, intervention: 'tow' })
    expect(r.success).toBe(false)
    expect(assessmentSchema.safeParse({ roadworthy: false, intervention: 'tow', reason: 'Seized gearbox' }).success).toBe(true)
  })

  it('drives a roadworthy unit in, and tows or inspects an immobile one', () => {
    expect(assessmentSchema.safeParse({ roadworthy: true, intervention: 'tow' }).success).toBe(false)
    expect(assessmentSchema.safeParse({ roadworthy: false, intervention: 'workshop', reason: 'x' }).success).toBe(false)
  })
})

describe('the workshop takes 3 booked vehicles a day', () => {
  beforeEach(() => {
    tx.repairReportItem.findFirst.mockResolvedValue(job())
    tx.repairAssessment.findFirst.mockResolvedValue({ roadworthy: true })
    tx.workshop.findFirst.mockResolvedValue({ id: 'w-1', name: 'Auto Workshop', dailyCapacity: 3 })
  })

  it('refuses a full day and names the next free one', async () => {
    tx.workshopBooking.count
      .mockResolvedValueOnce(3)   // the day asked for
      .mockResolvedValueOnce(3)   // the day after: also full
      .mockResolvedValueOnce(1)   // two days after: free
    const date = new Date('2030-01-10T00:00:00.000Z')
    const err = await book(ORG, 'job-1', 'u-1', { workshopId: 'w-1', date }, null).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(String(err.message)).toContain('full on 2030-01-10')
    expect(String(err.message)).toContain('next free day is 2030-01-12')
    expect(tx.workshopBooking.create).not.toHaveBeenCalled()
  })

  it('takes the booking when a slot is free, under the per-day lock', async () => {
    tx.workshopBooking.count.mockResolvedValueOnce(2)
    await book(ORG, 'job-1', 'u-1', { workshopId: 'w-1', date: new Date('2030-01-10T00:00:00.000Z') }, null)
    expect(tx.$queryRaw).toHaveBeenCalled()
    expect(tx.workshopBooking.create).toHaveBeenCalledOnce()
  })

  it('refuses to book a unit assessed as not roadworthy', async () => {
    tx.repairAssessment.findFirst.mockResolvedValue({ roadworthy: false })
    await expect(book(ORG, 'job-1', 'u-1', { workshopId: 'w-1', date: new Date('2030-01-10T00:00:00.000Z') }, null))
      .rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses a scoped user a unit outside their scope', async () => {
    await expect(book(ORG, 'job-1', 'u-1', { workshopId: 'w-1', date: new Date('2030-01-10T00:00:00.000Z') }, new Set(['v-other'])))
      .rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('completing and verifying', () => {
  it('classifies a workshop job before it is completed', async () => {
    tx.repairReportItem.findFirst.mockResolvedValue(job({ stage: 'fixing', ticketNo: 'RT-2026-00001' }))
    await expect(complete(ORG, 'job-1', 'u-1', { testResult: 'pass', fixNote: 'Pads replaced' }))
      .rejects.toBeInstanceOf(UnprocessableError)
  })

  it('a security investigation never gates the repair', async () => {
    // No securityInvestigation on the mock at all: if completing consulted
    // it, this would throw rather than complete.
    tx.repairReportItem.findFirst.mockResolvedValue(job({
      stage: 'fixing', ticketNo: 'RT-2026-00001', damageClass: 'suspected_malicious',
    }))
    const out = await complete(ORG, 'job-1', 'u-1', { testResult: 'pass', fixNote: 'Cable re-run and sealed' })
    expect(out.testFailed).toBe(false)
    expect(tx.repairReportItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: 'completed', completedById: 'u-1' }),
    }))
  })

  it('records a failed test without completing', async () => {
    tx.repairReportItem.findFirst.mockResolvedValue(job({ stage: 'remote_fix', path: 'remote' }))
    const out = await complete(ORG, 'job-1', 'u-1', { testResult: 'fail', testNote: 'Still reads 0 L', fixNote: 'Recalibrated' })
    expect(out.testFailed).toBe(true)
    expect(tx.repairReportItem.updateMany).not.toHaveBeenCalled()
  })

  it('is verified by someone other than the person who completed it', async () => {
    tx.repairReportItem.findFirst.mockResolvedValue(job({ stage: 'completed', completedById: 'u-1' }))
    await expect(verify(ORG, 'job-1', 'u-1', { decision: 'accept' }, null)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('closes the job fixed on acceptance', async () => {
    tx.repairReportItem.findFirst.mockResolvedValue(job({ stage: 'completed', completedById: 'u-1' }))
    await verify(ORG, 'job-1', 'u-2', { decision: 'accept' }, null)
    expect(tx.repairReportItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: 'fixed', verifiedById: 'u-2', resolvedById: 'u-1' }),
    }))
  })
})

describe('the Control Room and the Head of Security', () => {
  const perms = (slug: string) => new Set(ROLE_DEFINITIONS.find((r) => r.slug === slug)!.permissions)

  it('lets supervisor, fleet analyst and operator flag and book', () => {
    for (const slug of ['supervisor', 'fleet_analyst', 'operator']) {
      for (const p of ['repair:read', 'repair:flag', 'repair:book']) expect(perms(slug).has(p as never), `${slug} ${p}`).toBe(true)
    }
  })

  it('keeps assessing and verifying with the supervisor of the three', () => {
    expect(perms('supervisor').has('repair:assess' as never)).toBe(true)
    expect(perms('supervisor').has('repair:verify' as never)).toBe(true)
    for (const slug of ['fleet_analyst', 'operator']) {
      expect(perms(slug).has('repair:assess' as never), slug).toBe(false)
      expect(perms(slug).has('repair:verify' as never), slug).toBe(false)
    }
  })

  it('gives security cases to the Head of Security, not the Head of Section', () => {
    expect(perms('head_of_security').has('security_case:update' as never)).toBe(true)
    expect(perms('asst_head_of_security').has('security_case:read' as never)).toBe(true)
    expect(perms('asst_head_of_security').has('security_case:update' as never)).toBe(false)
    expect(perms('hos').has('security_case:read' as never)).toBe(false)
  })

  it('lets ControlTech technicians claim and source, and nothing more', () => {
    expect(perms('technician').has('repair:claim' as never)).toBe(true)
    expect(perms('technician').has('repair:parts_source' as never)).toBe(true)
    expect(perms('technician').has('repair:verify' as never)).toBe(false)
  })
})

describe('one road for every repair', () => {
  const spot = { vehicleIds: ['v-1'], suspectedFault: 'Probe reading flat', fixNote: 'Re-seated the probe connector' }

  it('lets a technician record an on-the-spot fix only when nothing came from stores', () => {
    expect(spotFixSchema.safeParse({ ...spot, storePartTaken: false }).success).toBe(true)
    const r = spotFixSchema.safeParse({ ...spot, storePartTaken: true })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.path).toEqual(['storePartTaken'])
  })

  it('takes old open jobs into the workflow where they stand', async () => {
    tx.workshopBooking.findMany.mockResolvedValue([])
    tx.securityInvestigation.findMany.mockResolvedValue([])
    tx.repairReportItem.findMany
      .mockResolvedValueOnce([
        job({ id: 'old-pending', stage: 'pending', outcome: 'audit', queue: null, path: null, faultCategory: 'fuel_probe', targetKind: 'probe' }),
        job({ id: 'old-fixing', stage: 'fixing', outcome: 'fixing', queue: null, path: null, faultCategory: null, targetKind: 'probe' }),
      ])
      .mockResolvedValue([])
    tx.$queryRaw.mockResolvedValue([{ n: 7n }])
    await workflowSweep(new Date('2026-10-21T08:00:00Z'))

    const writes = tx.repairReportItem.updateMany.mock.calls.map(([a]) => a as { where: { id: string }; data: Record<string, unknown> })
    const pending = writes.find((w) => w.where.id === 'old-pending')!
    expect(pending.data).toMatchObject({ queue: 'controltech', stage: 'forwarded' })
    expect(pending.data.ticketNo).toBeUndefined()
    const fixing = writes.find((w) => w.where.id === 'old-fixing')!
    expect(fixing.data).toMatchObject({ queue: 'controltech', path: 'physical', faultCategory: 'fuel_probe', ticketNo: 'RT-2026-00007' })
    expect(fixing.data.stage).toBeUndefined()
  })
})
