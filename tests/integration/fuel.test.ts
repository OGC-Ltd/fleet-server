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
  // Archived 2026-10-01: an alert leaves only by escalation or de-escalation.
  describe('POST /fuel/thefts/:id/dismiss (archived)', () => {
    it('answers 410 Gone with what to do instead, and writes nothing', async () => {
      prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: null } as never)

      const res = await request(app).post(`${THEFT_BASE}/th1/dismiss`)

      expect(res.status).toBe(410)
      expect(JSON.stringify(res.body)).toMatch(/Escalate or de-escalate/)
      expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.fuelTheftFollowUp.create).not.toHaveBeenCalled()
    })
  })
})
