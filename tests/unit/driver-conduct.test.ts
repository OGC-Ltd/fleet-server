/**
 * Driver conduct follow-up kept on the server: a report run's cases merged
 * without touching what operators recorded, actions by the signed-in user,
 * a browser's cases and logged incidents brought over once.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import {
  planFound, planImport, mergeFound, recordAction, importCases, saveIncident, deleteIncident, importIncidents, pendingCount,
} from '../../src/modules/reports/driver-conduct.service.js'
import { foundCasesSchema, caseActionSchema, incidentSchema, importCasesSchema } from '../../src/modules/reports/driver-conduct.schema.js'

const T = Date.parse('2026-11-01T08:00:00Z')
const found = (unit: string, day = '2026-11-01', over: object = {}) => ({
  id: `${unit}|${day}`, day, unitKey: unit, plate: unit, group: 'Tankers', driver: 'John Sialo',
  accel: 1, brake: 0, seatbelt: 0, phone: 2, covered: 0, openedAt: T, ...over,
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = (over: any = {}) => ({
  id: 'c1', organisationId: 'org1', caseKey: 'KCK345G|2026-11-01', day: '2026-11-01', unitKey: 'KCK345G', plate: 'KCK 345G',
  groupName: 'Tankers', driver: 'John Sialo', accel: 1, brake: 0, seatbelt: 0, phone: 2, covered: 0,
  openedAt: new Date(T), status: 'pending', action: null, note: '', actedBy: '', actedAt: null,
  createdAt: new Date(T), updatedAt: new Date(T), ...over,
})

describe('a report run\'s cases', () => {
  it('opens the new ones and updates the counts of the known, keeping the earlier opening', () => {
    const stored = new Map([['A|2026-11-01', { openedAt: new Date(T - 3_600_000) }]])
    const { create, update } = planFound(stored, [found('A', '2026-11-01', { phone: 5, openedAt: T }), found('B')])
    expect(create.map((c) => c.id)).toEqual(['B|2026-11-01'])
    expect(update).toHaveLength(1)
    expect(update[0]!.data).toMatchObject({ phone: 5, openedAt: new Date(T - 3_600_000) })
    // What an operator recorded is not among what a run writes
    expect(Object.keys(update[0]!.data)).not.toEqual(expect.arrayContaining(['status', 'action', 'note', 'actedBy', 'actedAt']))
  })

  it('writes them in one transaction and answers with every case', async () => {
    prismaMock.driverConductCase.findMany
      .mockResolvedValueOnce([{ caseKey: 'KCK345G|2026-11-01', openedAt: new Date(T) }] as never)
      .mockResolvedValueOnce([row({ status: 'done', action: 'Driver called' })] as never)
    const all = await mergeFound('org1', [found('KCK345G'), found('KBT114R')])
    expect(prismaMock.driverConductCase.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ organisationId: 'org1', caseKey: 'KBT114R|2026-11-01', phone: 2 })], skipDuplicates: true,
    }))
    expect(prismaMock.driverConductCase.update).toHaveBeenCalledTimes(1)
    expect(all[0]).toMatchObject({ id: 'KCK345G|2026-11-01', status: 'done', action: 'Driver called', openedAt: T })
  })

  it('counts what is pending, for the sidebar', async () => {
    prismaMock.driverConductCase.count.mockResolvedValueOnce(4)
    expect(await pendingCount('org1')).toBe(4)
    expect(prismaMock.driverConductCase.count).toHaveBeenCalledWith({ where: { organisationId: 'org1', status: 'pending' } })
  })
})

describe('an action on a case', () => {
  it('is recorded as the signed-in user, now', async () => {
    prismaMock.driverConductCase.findUnique.mockResolvedValueOnce({ id: 'c1' } as never)
    prismaMock.driverConductCase.update.mockResolvedValueOnce(row({ status: 'done', action: 'Verbal warning', actedBy: 'Ann Operator', actedAt: new Date() }) as never)
    const c = await recordAction('org1', 'KCK345G|2026-11-01', { action: 'Verbal warning', note: 'Called at 9' }, 'Ann Operator')
    expect(prismaMock.driverConductCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'done', action: 'Verbal warning', note: 'Called at 9', actedBy: 'Ann Operator' }),
    }))
    expect(c.status).toBe('done')
  })

  it('a null action reopens it', async () => {
    prismaMock.driverConductCase.findUnique.mockResolvedValueOnce({ id: 'c1' } as never)
    prismaMock.driverConductCase.update.mockResolvedValueOnce(row() as never)
    await recordAction('org1', 'KCK345G|2026-11-01', { action: null, note: '' }, 'Ann')
    expect(prismaMock.driverConductCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'pending', action: null, note: '', actedBy: '', actedAt: null },
    }))
  })

  it('on a case of another organisation, or none, is not found', async () => {
    prismaMock.driverConductCase.findUnique.mockResolvedValueOnce(null)
    await expect(recordAction('org1', 'X|2026-11-01', { action: 'Driver called', note: '' }, 'Ann')).rejects.toThrow(/not found/)
  })
})

describe('a browser\'s cases brought over', () => {
  it('adds those not held and takes a held one only when acted on later', () => {
    const stored = new Map([
      ['A|2026-11-01', { actedAt: new Date(T) }],
      ['B|2026-11-01', { actedAt: new Date(T + 10_000) }],
    ])
    const c = (id: string, actedAt: number | null) => ({ ...found(id), status: 'done' as const, action: 'Driver called', note: '', by: 'Ann', actedAt })
    const { create, update } = planImport(stored, [c('A', T + 5_000), c('B', T), c('C', null)])
    expect(update.map((x) => x.id)).toEqual(['A|2026-11-01'])
    expect(create.map((x) => x.id)).toEqual(['C|2026-11-01'])
  })

  it('keeps who acted and when, as the browser had it', async () => {
    prismaMock.driverConductCase.findMany.mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never)
    const out = await importCases('org1', [{ ...found('A'), status: 'done', action: 'Driver called', note: 'ok', by: 'Ann', actedAt: T + 1 }])
    expect(out.added).toBe(1)
    expect(prismaMock.driverConductCase.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ status: 'done', action: 'Driver called', actedBy: 'Ann', actedAt: new Date(T + 1) })],
    }))
  })
})

describe('incidents operators logged', () => {
  const entry = { id: 'oi-1', kind: 'phone' as const, other: '', at: T, vehicleId: 'v1', plate: 'KBT 114R', driver: '', location: '', status: 'Online' as const, details: '', by: '' }

  it('a new one is logged by the signed-in user', async () => {
    prismaMock.operatorIncident.findUnique.mockResolvedValueOnce(null)
    prismaMock.operatorIncident.create.mockResolvedValueOnce({ ...entry, organisationId: 'org1', at: new Date(T), loggedBy: 'Ann', loggedAt: new Date(T), updatedAt: new Date(T) } as never)
    const e = await saveIncident('org1', entry, 'Ann')
    expect(prismaMock.operatorIncident.create).toHaveBeenCalledWith({ data: expect.objectContaining({ id: 'oi-1', organisationId: 'org1', loggedBy: 'Ann' }) })
    expect(e).toMatchObject({ id: 'oi-1', by: 'Ann', at: T })
  })

  it('one belonging to another organisation cannot be changed or deleted', async () => {
    prismaMock.operatorIncident.findUnique.mockResolvedValueOnce({ organisationId: 'org2' } as never)
    await expect(saveIncident('org1', entry, 'Ann')).rejects.toThrow(/not found/)
    prismaMock.operatorIncident.deleteMany.mockResolvedValueOnce({ count: 0 })
    await expect(deleteIncident('org1', 'oi-1')).rejects.toThrow(/not found/)
  })

  it('a browser\'s entries come over once, keeping who logged them', async () => {
    prismaMock.operatorIncident.createMany.mockResolvedValueOnce({ count: 1 })
    const out = await importIncidents('org1', [{ ...entry, by: 'Bob', loggedAt: T }])
    expect(out.added).toBe(1)
    expect(prismaMock.operatorIncident.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ loggedBy: 'Bob', loggedAt: new Date(T) })], skipDuplicates: true,
    }))
  })
})

describe('requests', () => {
  it('a run sends fleet days and counts; anything else is refused', () => {
    expect(foundCasesSchema.safeParse({ cases: [found('A')] }).success).toBe(true)
    expect(foundCasesSchema.safeParse({ cases: [found('A', '1 Nov')] }).success).toBe(false)
    expect(caseActionSchema.safeParse({ action: null }).success).toBe(true)
    expect(caseActionSchema.safeParse({ action: '' }).success).toBe(false)
    expect(importCasesSchema.safeParse({ cases: [{ ...found('A'), status: 'weird' }] }).data?.cases[0]?.status).toBe('pending')
  })

  it('an incident needs a known kind and a unit', () => {
    expect(incidentSchema.safeParse({ id: 'x', kind: 'phone', at: T, plate: 'KBT 114R' }).success).toBe(true)
    expect(incidentSchema.safeParse({ id: 'x', kind: 'speeding', at: T, plate: 'KBT 114R' }).success).toBe(false)
    expect(incidentSchema.safeParse({ id: 'x', kind: 'phone', at: T }).success).toBe(false)
  })
})
