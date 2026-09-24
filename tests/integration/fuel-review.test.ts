import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID, testAuthUser } from '../helpers/factories.js'
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
  // Nobody is an administrator unless a test says so (see asAdmin).
  prismaMock.userRole.findMany.mockResolvedValue([] as never)
})

/** The organisation's system administrator: the role and membership the check reads. */
function asAdmin() {
  prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'admin' } }] as never)
  prismaMock.user.findFirst.mockResolvedValue({ id: 'someone' } as never)
}

const BASE = `/api/v1/organisations/${TEST_ORG_ID}/fuel/thefts`
const ME = testAuthUser.id

function reviewed(status: 'CONFIRMED_THEFT' | 'NOT_THEFT', note: string) {
  return {
    id: 'th1', vehicleId: 'v1', stolenMl: 10_700, reviewStatus: status,
    reviewedAt: new Date('2026-09-25T08:00:00Z'), reviewNote: note,
    reviewedBy: { fullName: 'Test User' }, vehicle: { registrationPlate: 'MUFINDI: EX 10' },
  }
}

describe('POST /fuel/thefts/:id/review', () => {
  it('escalates a live alert: confirmed theft on the row, THEFT label for the detector', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', dismissedAt: null } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('CONFIRMED_THEFT', 'Seen on camera') as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(200)
    expect(res.body.data.review).toMatchObject({ status: 'CONFIRMED_THEFT', by: 'Test User', note: 'Seen on camera' })
    expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith({
      where: { id: 'th1', dismissedAt: null },
      data: expect.objectContaining({ reviewStatus: 'CONFIRMED_THEFT', reviewedById: ME, reviewNote: 'Seen on camera' }),
    })
    expect(prismaMock.fuelEventLabel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ eventId: 'th1', eventType: 'THEFT', label: 'THEFT', labelledBy: 'test@fleet.dev' }),
    }))
    // Escalating does not take it off the dashboard.
    expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dismissedAt: expect.anything() }),
    }))
  })

  it('de-escalates as not a theft, and a later decision replaces the earlier one', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', dismissedAt: null } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('NOT_THEFT', 'Probe recalibrated') as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'DEESCALATED', note: 'Probe recalibrated' })

    expect(res.status).toBe(200)
    expect(res.body.data.review.status).toBe('NOT_THEFT')
    expect(prismaMock.fuelEventLabel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ label: 'NOT_THEFT', note: 'Probe recalibrated' }),
    }))
  })

  it('is for administrators only', async () => {
    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(403)
    expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
  })

  it('sends a deleted alert to its Case instead', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', dismissedAt: new Date() } as never)
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(409)
    expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
  })

  it('scopes the alert to the path organisation', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue(null)
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)

    const res = await request(app).post(`${BASE}/elsewhere/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(404)
    expect(prismaMock.fuelTheft.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'elsewhere', vehicle: { organisationId: TEST_ORG_ID } },
    }))
  })

  it('requires an outcome and a reason', async () => {
    asAdmin()
    expect((await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED' })).status).toBe(400)
    expect((await request(app).post(`${BASE}/th1/review`).send({ outcome: 'LOUDER', note: 'Seen on camera' })).status).toBe(400)
  })
})

describe('GET /fuel/thefts/review-rights', () => {
  it('says yes to an administrator', async () => {
    asAdmin()
    const res = await request(app).get(`${BASE}/review-rights`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ canReview: true })
  })

  it('says no to everyone else, rather than refusing', async () => {
    const res = await request(app).get(`${BASE}/review-rights`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ canReview: false })
  })
})
