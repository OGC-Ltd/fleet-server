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
  it('escalates a live alert: confirmed theft on the row, THEFT label, and off the dashboard', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: null } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('CONFIRMED_THEFT', 'Seen on camera') as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(200)
    expect(res.body.data.review).toMatchObject({ status: 'CONFIRMED_THEFT', by: 'Test User', note: 'Seen on camera' })
    expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith({
      where: { id: 'th1', dismissedAt: null },
      // The decision is the trail: status, note, who; and it leaves the dashboard.
      data: expect.objectContaining({
        reviewStatus: 'CONFIRMED_THEFT', reviewedById: ME, reviewNote: 'Seen on camera',
        dismissedAt: expect.any(Date), dismissedById: ME,
      }),
    })
    expect(prismaMock.fuelEventLabel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ eventId: 'th1', eventType: 'THEFT', label: 'THEFT', labelledBy: 'test@fleet.dev' }),
    }))
    // No case is opened: a decided alert is finished, not waiting on anybody.
    expect(prismaMock.fuelTheftFollowUp.create).not.toHaveBeenCalled()
    // And the decision is in the log the Alerts page reads.
    expect(prismaMock.alertDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organisationId: TEST_ORG_ID, kind: 'FUEL', alertId: 'th1', outcome: 'ESCALATED', reason: 'theft', actorId: ME,
      }),
    })
  })

  it("takes the unit's older live alerts off the dashboard with the one decided", async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: null } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.fuelTheft.findMany.mockResolvedValue([{ id: 'th0' }] as never)
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('NOT_THEFT', 'Slosh on a slope') as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'DEESCALATED', note: 'Slosh on a slope' })

    expect(res.status).toBe(200)
    expect(prismaMock.fuelTheft.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ vehicleId: 'v1', id: { not: 'th1' }, dismissedAt: null }),
    }))
    expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['th0'] }, dismissedAt: null },
      data: expect.objectContaining({ dismissedAt: expect.any(Date), dismissedById: ME }),
    })
  })

  it('de-escalates as not a theft, off the dashboard with the decision kept', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', dismissedAt: null } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('NOT_THEFT', 'Probe recalibrated') as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'DEESCALATED', note: 'Probe recalibrated' })

    expect(res.status).toBe(200)
    expect(res.body.data.review.status).toBe('NOT_THEFT')
    expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith({
      where: { id: 'th1', dismissedAt: null },
      data: expect.objectContaining({ reviewStatus: 'NOT_THEFT', reviewNote: 'Probe recalibrated', dismissedAt: expect.any(Date) }),
    })
    expect(prismaMock.fuelEventLabel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ label: 'NOT_THEFT', note: 'Probe recalibrated' }),
    }))
  })

  it('escalated as a faulty probe: off the dashboard, a case in Fuel Audit and a probe job in Repairs', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', dismissedAt: null } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue({
      id: 'th1', vehicleId: 'v1', vehicle: { registrationPlate: 'MUFINDI: EX 10', name: null }, driver: null,
    } as never)
    prismaMock.repairReportItem.findFirst.mockResolvedValue(null)
    prismaMock.repairReport.create.mockResolvedValue({ items: [{ id: 'ri1' }] } as never)
    prismaMock.fuelTheftFollowUp.create.mockResolvedValue({ id: 'fu9' } as never)
    prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue({
      id: 'fu9', status: 'PROBE_FAULT', acceptedBy: { id: ME, fullName: 'Test User' }, actions: [],
      theft: { id: 'th1', vehicleId: 'v1', stolenMl: 10_700, vehicle: { registrationPlate: 'MUFINDI: EX 10' } },
    } as never)

    const res = await request(app).post(`${BASE}/th1/review`)
      .send({ outcome: 'ESCALATED', reason: 'probe_fault', note: 'Level jumps on rough road' })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ review: { status: 'PROBE_FAULT', by: 'Test User' }, followUpId: 'fu9' })
    expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith({
      where: { id: 'th1', dismissedAt: null },
      data: expect.objectContaining({ dismissedAt: expect.any(Date), reviewStatus: 'PROBE_FAULT' }),
    })
    expect(prismaMock.fuelTheftFollowUp.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ theftId: 'th1', status: 'PROBE_FAULT', acceptedById: ME, repairItemId: 'ri1' }),
    }))
    expect(prismaMock.repairReport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        items: { create: [expect.objectContaining({ targetKind: 'probe', vehicleId: 'v1', outcome: 'audit', stage: 'pending' })] },
      }),
    }))
    expect(prismaMock.fuelEventLabel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ label: 'NOT_THEFT' }),
    }))
  })

  it('rejects an escalation reason it does not know', async () => {
    asAdmin()
    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', reason: 'aliens', note: 'Seen on camera' })
    expect(res.status).toBe(400)
  })

  it('is for administrators only', async () => {
    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(403)
    expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
  })

  it('refuses an alert escalated as a faulty probe: its case is in Fuel Audit', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({
      id: 'th1', dismissedAt: new Date(), reviewStatus: 'PROBE_FAULT', followUp: { id: 'fu1', status: 'PROBE_FAULT' },
    } as never)
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(409)
    expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
  })

  it('refuses the decision an alert already carries', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({
      id: 'th1', dismissedAt: new Date(), reviewStatus: 'CONFIRMED_THEFT', followUp: null,
    } as never)
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Seen on camera' })

    expect(res.status).toBe(409)
    expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
  })

  it('changes an earlier decision, logs both, and takes nothing else off the map', async () => {
    asAdmin()
    const decidedAt = new Date('2026-10-10T08:00:00Z')
    prismaMock.fuelTheft.findFirst.mockResolvedValue({
      id: 'th1', vehicleId: 'v1', beganAt: new Date('2026-10-10T06:00:00Z'), dismissedAt: decidedAt,
      reviewStatus: 'NOT_THEFT', reviewedAt: decidedAt, followUp: null,
    } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('CONFIRMED_THEFT', 'Driver admitted it') as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'ESCALATED', note: 'Driver admitted it' })

    expect(res.status).toBe(200)
    // Conditional on the decision it replaces; it was already off the map.
    expect(prismaMock.fuelTheft.updateMany).toHaveBeenCalledWith({
      where: { id: 'th1', reviewStatus: 'NOT_THEFT', reviewedAt: decidedAt },
      data: { reviewStatus: 'CONFIRMED_THEFT', reviewedAt: expect.any(Date), reviewedById: ME, reviewNote: 'Driver admitted it' },
    })
    expect(prismaMock.fuelTheft.findMany).not.toHaveBeenCalled()
    expect(prismaMock.alertDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'FUEL', alertId: 'th1', outcome: 'ESCALATED', reason: 'theft', note: 'Driver admitted it', actorId: ME,
      }),
    })
  })

  it('decides an alert deleted into a case before Delete was retired, and closes the case', async () => {
    asAdmin()
    prismaMock.fuelTheft.findFirst.mockResolvedValue({
      id: 'th1', vehicleId: 'v1', beganAt: new Date('2026-09-28T06:00:00Z'), dismissedAt: new Date('2026-09-28T07:00:00Z'),
      reviewStatus: 'DISMISSED', reviewedAt: new Date('2026-09-28T07:00:00Z'), followUp: { id: 'fu1', status: 'OPEN' },
    } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('NOT_THEFT', 'Refuel mis-read') as never)

    const res = await request(app).post(`${BASE}/th1/review`).send({ outcome: 'DEESCALATED', note: 'Refuel mis-read' })

    expect(res.status).toBe(200)
    expect(prismaMock.fuelTheftFollowUp.update).toHaveBeenCalledWith({
      where: { id: 'fu1' }, data: { status: 'DEESCALATED', resolvedAt: expect.any(Date) },
    })
    expect(prismaMock.fuelTheftFollowUpAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ followUpId: 'fu1', kind: 'DEESCALATED', actorId: ME, note: 'Refuel mis-read' }),
    })
  })

  it('clears only the alerts that began no later than the one decided', async () => {
    asAdmin()
    const beganAt = new Date(Date.now() - 3_600_000)
    prismaMock.fuelTheft.findFirst.mockResolvedValue({ id: 'th1', vehicleId: 'v1', beganAt, dismissedAt: null } as never)
    prismaMock.fuelTheft.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
    prismaMock.fuelTheft.findUniqueOrThrow.mockResolvedValue(reviewed('NOT_THEFT', 'Slosh on a slope') as never)

    await request(app).post(`${BASE}/th1/review`).send({ outcome: 'DEESCALATED', note: 'Slosh on a slope' })

    expect(prismaMock.fuelTheft.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ beganAt: expect.objectContaining({ lte: beganAt }) }),
    }))
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
