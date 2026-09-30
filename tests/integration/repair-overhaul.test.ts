import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock, resetTestSubject } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')

vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })
beforeEach(() => {
  resetTestSubject()
  prismaMock.user.findUnique.mockResolvedValue({ fullName: 'Test User' } as never)
})

const BASE = `/api/v1/organisations/${TEST_ORG_ID}/repairs/items`
const job = (stage: string, over: Record<string, unknown> = {}) =>
  ({ id: 'ri1', stage, resolvedAt: null, stageHistory: [], ...over })
const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

describe('Repair overhaul: spare parts', () => {
  it('orders a part and moves a pending job to spare_outsourced, with the reason on its tracking line', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue(job('pending') as never)
    prismaMock.repairSparePart.create.mockResolvedValue({ id: 'sp1', name: 'FLS probe', status: 'ordered' } as never)
    prismaMock.repairSparePart.findMany.mockResolvedValue([
      { name: 'FLS probe', quantity: 1, expectedAt: new Date(`${inAWeek}T00:00:00Z`), status: 'ordered' },
    ] as never)

    const res = await request(app).post(`${BASE}/ri1/parts`)
      .send({ name: 'FLS probe', quantity: 1, supplier: 'Nairobi Sensors', costKes: 18500, expectedAt: inAWeek })

    expect(res.status).toBe(201)
    expect(prismaMock.repairSparePart.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ repairItemId: 'ri1', name: 'FLS probe', supplier: 'Nairobi Sensors', costKes: 18500 }),
    }))
    expect(prismaMock.repairReportItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ri1', resolvedAt: null, stage: 'pending' },
      data: expect.objectContaining({
        stage: 'spare_outsourced',
        stageHistory: [expect.objectContaining({ stage: 'spare_outsourced', note: 'Spare ordered: FLS probe from Nairobi Sensors' })],
      }),
    }))
    // The job's own summary follows the parts.
    expect(prismaMock.repairReportItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ri1' }, data: expect.objectContaining({ sparePart: 'FLS probe' }),
    }))
  })

  it('moves the job to fixing once every live part has arrived', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue(job('spare_outsourced') as never)
    prismaMock.repairSparePart.findFirst.mockResolvedValue({ id: 'sp1', status: 'ordered', note: null } as never)
    prismaMock.repairSparePart.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.repairSparePart.findMany.mockResolvedValue([{ status: 'received', name: 'FLS probe', quantity: 1, expectedAt: null }] as never)
    prismaMock.repairSparePart.findUniqueOrThrow.mockResolvedValue({ id: 'sp1', status: 'received' } as never)

    const res = await request(app).post(`${BASE}/ri1/parts/sp1`).send({ status: 'received' })

    expect(res.status).toBe(200)
    expect(prismaMock.repairReportItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: 'fixing' }),
    }))
  })

  it('refuses a move a part cannot make', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue(job('spare_outsourced') as never)
    prismaMock.repairSparePart.findFirst.mockResolvedValue({ id: 'sp1', status: 'ordered', note: null } as never)

    const res = await request(app).post(`${BASE}/ri1/parts/sp1`).send({ status: 'fitted' })

    expect(res.status).toBe(409)
    expect(prismaMock.repairSparePart.updateMany).not.toHaveBeenCalled()
  })

  it('does nothing to a job already signed off', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue(job('fixed', { resolvedAt: new Date() }) as never)

    const res = await request(app).post(`${BASE}/ri1/parts`).send({ name: 'FLS probe' })

    expect(res.status).toBe(409)
    expect(prismaMock.repairSparePart.create).not.toHaveBeenCalled()
  })

  it('needs a part name', async () => {
    const res = await request(app).post(`${BASE}/ri1/parts`).send({ supplier: 'Nairobi Sensors' })
    expect(res.status).toBe(400)
  })
})

describe('Repair overhaul: sign-off', () => {
  it('cannot be signed off fixed while a spare is outstanding', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue(null)
    prismaMock.repairSparePart.findMany.mockResolvedValue([{ name: 'FLS probe', status: 'received' }] as never)

    const res = await request(app).post(`${BASE}/ri1/resolve`).send({ fixNote: 'Done', verdict: 'fixed' })

    expect(res.status).toBe(409)
    expect(res.body.message ?? res.body.error?.message).toMatch(/FLS probe \(not fitted\)/)
    expect(prismaMock.repairReportItem.updateMany).not.toHaveBeenCalled()
  })
})

describe('Repair overhaul: inspection checklist', () => {
  it('records a component check, overwriting the earlier one', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue(job('fixing') as never)
    prismaMock.repairInspection.upsert.mockResolvedValue({ id: 'in1', component: 'probe_cable', verdict: 'faulty' } as never)

    const res = await request(app).post(`${BASE}/ri1/inspections`)
      .send({ component: 'probe_cable', verdict: 'faulty', note: 'Connector corroded' })

    expect(res.status).toBe(200)
    expect(prismaMock.repairInspection.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { repairItemId_component: { repairItemId: 'ri1', component: 'probe_cable' } },
      update: expect.objectContaining({ verdict: 'faulty', note: 'Connector corroded', inspectedBy: 'Test User' }),
    }))
  })

  it('knows only the checklist components', async () => {
    const res = await request(app).post(`${BASE}/ri1/inspections`).send({ component: 'engine', verdict: 'ok' })
    expect(res.status).toBe(400)
  })
})

