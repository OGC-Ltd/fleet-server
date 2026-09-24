import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { makeFilling, makeTheft, TEST_ORG_ID, testAuthUser } from '../helpers/factories.js'
import { authMock, authorizeMock } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')

vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })


const FILL_BASE = `/api/v1/organisations/${TEST_ORG_ID}/fuel/fillings`
const THEFT_BASE = `/api/v1/organisations/${TEST_ORG_ID}/fuel/thefts`

describe('Fuel Fillings', () => {
  describe('GET /fuel/fillings', () => {
    it('returns cursor-paginated fillings', async () => {
      prismaMock.fuelFilling.findMany.mockResolvedValue([makeFilling()] as never)

      const res = await request(app).get(FILL_BASE)

      expect(res.status).toBe(200)
      expect(res.body.meta).toHaveProperty('hasNextPage')
    })
  })

  describe('POST /fuel/fillings', () => {
    it('creates filling and returns 201', async () => {
      const filling = makeFilling({ id: 'f1' })
      prismaMock.fuelFilling.create.mockResolvedValue(filling)

      const res = await request(app).post(FILL_BASE).send({
        vehicleId: 'clv1234567890abcdefghijklm',
        reportingPeriodId: 'clp1234567890abcdefghijklm',
        filledAt: '2026-06-01T10:00:00Z',
        filledMl: 50000,
      })

      expect(res.status).toBe(201)
    })

    it('returns 400 for zero filledMl', async () => {
      const res = await request(app).post(FILL_BASE).send({
        vehicleId: 'clv1234567890abcdefghijklm',
        reportingPeriodId: 'clp1234567890abcdefghijklm',
        filledAt: '2026-06-01T10:00:00Z',
        filledMl: 0,
      })

      expect(res.status).toBe(400)
    })
  })
})

describe('Fuel Thefts', () => {
  describe('GET /fuel/thefts', () => {
    it('returns cursor-paginated thefts', async () => {
      prismaMock.fuelTheft.findMany.mockResolvedValue([makeTheft()] as never)

      const res = await request(app).get(THEFT_BASE)

      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
    })
  })

  describe('POST /fuel/thefts', () => {
    it('creates theft record and returns 201', async () => {
      const theft = makeTheft({ id: 'th1' })
      prismaMock.fuelTheft.create.mockResolvedValue(theft)

      const res = await request(app).post(THEFT_BASE).send({
        vehicleId: 'clv1234567890abcdefghijklm',
        reportingPeriodId: 'clp1234567890abcdefghijklm',
        beganAt: '2026-06-01T02:00:00Z',
        detectedAt: '2026-06-01T02:30:00Z',
        stolenMl: 20000,
      })

      expect(res.status).toBe(201)
    })

    it('returns 400 when stolenMl is missing', async () => {
      const res = await request(app).post(THEFT_BASE).send({
        vehicleId: 'clv1234567890abcdefghijklm',
        reportingPeriodId: 'clp1234567890abcdefghijklm',
        beganAt: '2026-06-01T02:00:00Z',
        detectedAt: '2026-06-01T02:30:00Z',
      })

      expect(res.status).toBe(400)
    })
  })
  describe('POST /fuel/thefts/:id/dismiss', () => {
    it('marks the row dismissed and keeps it (update, never delete)', async () => {
      prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: null } as never)
      prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.fuelTheftFollowUp.create.mockResolvedValue({ id: 'fu1' } as never)

      const res = await request(app).post(`${THEFT_BASE}/th1/dismiss`)

      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe('th1')
      expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'th1', dismissedAt: null },
        data: expect.objectContaining({ dismissedAt: expect.any(Date) }),
      }))
      expect(prismaMock.fuelTheft.delete).not.toHaveBeenCalled()
    })

    it('opens a follow-up recording who deleted it', async () => {
      prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: null } as never)
      prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.fuelTheftFollowUp.create.mockResolvedValue({ id: 'fu1' } as never)
      prismaMock.fuelTheft.findUnique.mockResolvedValue(makeTheft({ id: 'th1', stolenMl: 23_500 }) as never)

      const res = await request(app).post(`${THEFT_BASE}/th1/dismiss`)

      expect(res.body.data.followUpId).toBe('fu1')
      expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ reviewStatus: 'DISMISSED', reviewedById: testAuthUser.id }),
      }))
      expect(prismaMock.fuelTheftFollowUp.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          organisationId: TEST_ORG_ID, theftId: 'th1', dismissedById: testAuthUser.id,
          incidentSnapshot: expect.objectContaining({ id: 'th1', stolenMl: 23_500 }),
          actions: { create: expect.objectContaining({ kind: 'OPENED', actorId: testAuthUser.id }) },
        }),
      }))
    })

    it('opens no second follow-up when someone else dismissed it first', async () => {
      prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: null } as never)
      prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 0 })
      prismaMock.fuelTheft.findUnique.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: new Date() } as never)

      const res = await request(app).post(`${THEFT_BASE}/th1/dismiss`)

      expect(res.status).toBe(200)
      expect(res.body.data.followUpId).toBeNull()
      expect(prismaMock.fuelTheftFollowUp.create).not.toHaveBeenCalled()
    })

    it('scopes the lookup to the path organisation', async () => {
      prismaMock.fuelTheft.findFirst.mockResolvedValue(null)

      const res = await request(app).post(`${THEFT_BASE}/other-org-row/dismiss`)

      expect(res.status).toBe(404)
      expect(prismaMock.fuelTheft.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'other-org-row', vehicle: { organisationId: TEST_ORG_ID } },
      }))
      expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
    })

    it('keeps the first dismissal rather than overwriting it', async () => {
      const first = new Date('2026-09-24T10:00:00Z')
      prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: first } as never)

      const res = await request(app).post(`${THEFT_BASE}/th1/dismiss`)

      expect(res.status).toBe(200)
      expect(res.body.data.dismissedAt).toBe(first.toISOString())
      expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.fuelTheftFollowUp.create).not.toHaveBeenCalled()
    })
  })
})
