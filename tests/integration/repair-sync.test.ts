/**
 * Maintenance > Repairs and Fuel > Audit show the same jobs, so every repair
 * write is broadcast to the organisation's dashboards (`repair_changed`) and
 * both views re-read. Only a write that SUCCEEDED is announced.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock, resetTestSubject } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

const emitted = vi.hoisted(() => [] as string[])
vi.mock('../../src/lib/sse.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/sse.js')>()),
  emitDashboardRepairChanged: (orgId: string) => { emitted.push(orgId) },
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express
beforeAll(async () => { app = await buildApp() })
beforeEach(() => {
  resetTestSubject()
  emitted.length = 0
  prismaMock.user.findUnique.mockResolvedValue({ fullName: 'Test User' } as never)
})

const BASE = `/api/v1/organisations/${TEST_ORG_ID}/repairs/items`
const settle = () => new Promise((r) => setTimeout(r, 10))

describe('repair_changed broadcast', () => {
  it('announces a successful write to the organisation', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue({ id: 'ri1', stage: 'pending', resolvedAt: null, stageHistory: [] } as never)
    prismaMock.repairInspection.upsert.mockResolvedValue({ id: 'i1' } as never)

    const res = await request(app).post(`${BASE}/ri1/inspections`).send({ component: 'probe', verdict: 'faulty' })
    await settle()

    expect(res.status).toBe(200)
    expect(emitted).toEqual([TEST_ORG_ID])
  })

  it('says nothing when the write failed', async () => {
    prismaMock.repairReportItem.findFirst.mockResolvedValue(null)

    const res = await request(app).post(`${BASE}/ri1/inspections`).send({ component: 'probe', verdict: 'faulty' })
    await settle()

    expect(res.status).toBe(404)
    expect(emitted).toEqual([])
  })

  it('says nothing for a read', async () => {
    prismaMock.repairReportItem.findMany.mockResolvedValue([] as never)
    await request(app).get(`${BASE}`)
    await settle()
    expect(emitted).toEqual([])
  })
})
