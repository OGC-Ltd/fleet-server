import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID, testAuthUser } from '../helpers/factories.js'
import { authMock, authorizeMock, setTestSubject, resetTestSubject } from '../helpers/auth-mock.js'

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

/**
 * Make the caller the organisation's system administrator: the role the
 * assigner check reads, and the membership it requires (repairs.authz).
 */
function asAdmin() {
  prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'admin' } }] as never)
  prismaMock.user.findFirst.mockResolvedValue({ id: 'someone' } as never)
}

const BASE = `/api/v1/organisations/${TEST_ORG_ID}/fuel/followups`
const ME = testAuthUser.id
const person = (id: string, fullName: string) => ({ id, fullName })

/** A follow-up row as FOLLOW_UP_SELECT reads it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'fu1',
    status: 'OPEN',
    openedAt: new Date('2026-09-24T10:00:00Z'),
    acceptedAt: null,
    resolvedAt: null,
    assignedAt: null,
    dismissedById: 'deleter',
    acceptedById: null,
    assignedToId: null,
    dismissedBy: person('deleter', 'Dee Leter'),
    acceptedBy: null,
    assignedTo: null,
    assignedBy: null,
    theft: {
      id: 'th1', vehicleId: 'v1', stolenMl: 23_500,
      beganAt: new Date('2026-09-24T09:00:00Z'), detectedAt: new Date('2026-09-24T09:05:00Z'),
      drainCause: 'SIPHON', initialLocation: null,
      vehicle: { registrationPlate: 'MUFINDI - DZ 20' },
    },
    actions: [],
    ...over,
  }
}

describe('Fuel follow-ups', () => {
  describe('GET /fuel/followups', () => {
    it('lists the organisation\'s outstanding follow-ups by default', async () => {
      prismaMock.fuelTheftFollowUp.findMany.mockResolvedValue([row()] as never)

      const res = await request(app).get(BASE)

      expect(res.status).toBe(200)
      expect(res.body.data[0]).toMatchObject({
        id: 'fu1', status: 'OPEN',
        dismissedBy: { fullName: 'Dee Leter' },
        incident: { id: 'th1', plate: 'MUFINDI - DZ 20', volumeMl: 23_500 },
        viewer: { deletedIt: false, ownsIt: false },
      })
      expect(prismaMock.fuelTheftFollowUp.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { organisationId: TEST_ORG_ID, status: { in: ['OPEN', 'ACCEPTED'] } },
      }))
    })
  })

  describe('POST /fuel/followups/:id/accept', () => {
    it('makes the caller the owner and logs it', async () => {
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(row() as never)
        .mockResolvedValueOnce(row({ status: 'ACCEPTED', acceptedById: ME, acceptedBy: person(ME, 'Test User') }) as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/accept`)

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ status: 'ACCEPTED', viewer: { ownsIt: true } })
      expect(prismaMock.fuelTheftFollowUp.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        // Conditional on nobody else having been assigned it meanwhile.
        where: { id: 'fu1', status: 'OPEN', OR: [{ assignedToId: null }, { assignedToId: ME }] },
        data: expect.objectContaining({ status: 'ACCEPTED', acceptedById: ME }),
      }))
      expect(prismaMock.fuelTheftFollowUpAction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ followUpId: 'fu1', kind: 'ACCEPTED', actorId: ME }),
      }))
      // The alert's own record moves with it.
      expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith({
        where: { id: 'th1' },
        data: expect.objectContaining({ reviewStatus: 'UNDER_REVIEW', reviewedById: ME }),
      })
    })

    it('is closed to roles without case rights', async () => {
      setTestSubject({ permissions: ['fuel_theft:read', 'fuel_theft:create'] })

      const res = await request(app).post(`${BASE}/fu1/accept`)

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.findFirst).not.toHaveBeenCalled()
    })

    it('refuses the account that deleted the alert', async () => {
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row({ dismissedById: ME }) as never)

      const res = await request(app).post(`${BASE}/fu1/accept`)

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('is the assignee\'s alone once an administrator has assigned it', async () => {
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(
        row({ assignedToId: 'tech', assignedTo: person('tech', 'Tess Tech') }) as never,
      )

      const res = await request(app).post(`${BASE}/fu1/accept`)

      expect(res.status).toBe(403)
      expect(res.body.error?.message ?? res.body.message).toContain('Tess Tech')
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('loses the race cleanly when somebody else accepted first', async () => {
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(row() as never)
        .mockResolvedValueOnce(row({ status: 'ACCEPTED', acceptedById: 'other', acceptedBy: person('other', 'Otto') }) as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 0 })

      const res = await request(app).post(`${BASE}/fu1/accept`)

      expect(res.status).toBe(409)
      expect(res.body.error?.message ?? res.body.message).toContain('Otto')
      expect(prismaMock.fuelTheftFollowUpAction.create).not.toHaveBeenCalled()
    })

    it('is scoped to the path organisation', async () => {
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(null)

      const res = await request(app).post(`${BASE}/elsewhere/accept`)

      expect(res.status).toBe(404)
      expect(prismaMock.fuelTheftFollowUp.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'elsewhere', organisationId: TEST_ORG_ID },
      }))
    })
  })

  describe('POST /fuel/followups/:id/decline', () => {
    const declined = (by = ME) => ({ id: 'a1', kind: 'DECLINED', note: 'On leave this week', at: new Date(), actor: person(by, 'Test User'), subject: null })

    it('logs the decline with its reason and marks the follow-up as needing an administrator', async () => {
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(row() as never)
        .mockResolvedValueOnce(row({ actions: [declined()] }) as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/decline`).send({ note: 'On leave this week' })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ status: 'OPEN', needsAssigning: true, viewer: { declinedIt: true } })
      expect(prismaMock.fuelTheftFollowUp.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'fu1', status: 'OPEN', assignedToId: null },
      }))
      expect(prismaMock.fuelTheftFollowUpAction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ kind: 'DECLINED', actorId: ME, note: 'On leave this week' }),
      }))
    })

    it('hands an assignment back, unassigned, when the assignee declines it', async () => {
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(row({ assignedToId: ME, assignedTo: person(ME, 'Test User') }) as never)
        .mockResolvedValueOnce(row({ actions: [declined()] }) as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/decline`).send({ note: 'Not my site' })

      expect(res.status).toBe(200)
      expect(prismaMock.fuelTheftFollowUp.updateMany).toHaveBeenCalledWith({
        where: { id: 'fu1', status: 'OPEN', assignedToId: ME },
        data: { assignedToId: null, assignedById: null, assignedAt: null },
      })
    })

    it('is not open to anyone but the assignee once it is assigned', async () => {
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(
        row({ assignedToId: 'tech', assignedTo: person('tech', 'Tess Tech') }) as never,
      )

      const res = await request(app).post(`${BASE}/fu1/decline`).send({ note: 'Not mine either' })

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('is not taken twice from the same person', async () => {
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row({ actions: [declined()] }) as never)

      const res = await request(app).post(`${BASE}/fu1/decline`).send({ note: 'Still no' })

      expect(res.status).toBe(409)
    })

    it('requires a reason', async () => {
      const res = await request(app).post(`${BASE}/fu1/decline`).send({})

      expect(res.status).toBe(400)
    })
  })

  describe('POST /fuel/followups/:id/assign', () => {
    it('lets an administrator hand it to a case holder, and logs who was sent', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(row() as never)
        .mockResolvedValueOnce(row({ assignedToId: 'tech', assignedTo: person('tech', 'Tess Tech'), assignedBy: person(ME, 'Test User') }) as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/assign`).send({ assigneeId: 'tech', note: 'You know that yard' })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ status: 'OPEN', assignedTo: { fullName: 'Tess Tech' }, viewer: { canAssign: true } })
      expect(prismaMock.fuelTheftFollowUp.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'fu1', status: { in: ['OPEN', 'ACCEPTED'] } },
        data: expect.objectContaining({ status: 'OPEN', acceptedById: null, assignedToId: 'tech', assignedById: ME }),
      }))
      expect(prismaMock.fuelTheftFollowUpAction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ kind: 'ASSIGNED', actorId: ME, subjectId: 'tech', note: 'You know that yard' }),
      }))
      expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith({ where: { id: 'th1' }, data: { reviewStatus: 'DISMISSED' } })
    })

    it('takes an accepted follow-up off its owner when it is reassigned', async () => {
      asAdmin()
      const accepted = row({ status: 'ACCEPTED', acceptedById: 'otto', acceptedBy: person('otto', 'Otto') })
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(accepted as never)
        .mockResolvedValueOnce(row({ assignedToId: 'tech', assignedTo: person('tech', 'Tess Tech') }) as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/assign`).send({ assigneeId: 'tech' })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('OPEN')
    })

    it('is refused to anyone who is not an administrator', async () => {
      const res = await request(app).post(`${BASE}/fu1/assign`).send({ assigneeId: 'tech' })

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('never gives the follow-up to the account that deleted the alert', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row() as never)

      const res = await request(app).post(`${BASE}/fu1/assign`).send({ assigneeId: 'deleter' })

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('only names an active member with case rights', async () => {
      asAdmin()
      prismaMock.user.findFirst
        .mockResolvedValueOnce({ id: ME } as never) // the administrator's own membership
        .mockResolvedValueOnce(null)                // the assignee fails the test
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row() as never)

      const res = await request(app).post(`${BASE}/fu1/assign`).send({ assigneeId: 'driver' })

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('does nothing to a closed follow-up', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row({ status: 'ESCALATED' }) as never)

      const res = await request(app).post(`${BASE}/fu1/assign`).send({ assigneeId: 'tech' })

      expect(res.status).toBe(409)
    })
  })

  describe('POST /fuel/followups/:id/recall', () => {
    const recalled = (from: string, fromName: string) => row({
      actions: [{ id: 'r1', kind: 'RECALLED', note: null, at: new Date(), actor: person(ME, 'Test User'), subject: person(from, fromName) }],
    })

    it('takes an assignment back from the assignee and logs who it was taken from', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(row({ assignedToId: 'tech', assignedTo: person('tech', 'Tess Tech') }) as never)
        .mockResolvedValueOnce(recalled('tech', 'Tess Tech') as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/recall`).send({ note: 'Tess is off sick' })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ status: 'OPEN', assignedTo: null })
      expect(prismaMock.fuelTheftFollowUp.updateMany).toHaveBeenCalledWith({
        where: { id: 'fu1', status: 'OPEN', assignedToId: 'tech' },
        data: {
          status: 'OPEN', acceptedById: null, acceptedAt: null,
          assignedToId: null, assignedById: null, assignedAt: null,
        },
      })
      expect(prismaMock.fuelTheftFollowUpAction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ kind: 'RECALLED', actorId: ME, subjectId: 'tech', note: 'Tess is off sick' }),
      }))
    })

    it('takes an accepted follow-up back from its reviewer', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(row({ status: 'ACCEPTED', acceptedById: 'otto', acceptedBy: person('otto', 'Otto') }) as never)
        .mockResolvedValueOnce(recalled('otto', 'Otto') as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/recall`).send({})

      expect(res.status).toBe(200)
      expect(prismaMock.fuelTheftFollowUp.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'fu1', status: 'ACCEPTED', acceptedById: 'otto' },
      }))
      expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith({ where: { id: 'th1' }, data: { reviewStatus: 'DISMISSED' } })
    })

    it('has nothing to recall when nobody holds it', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row() as never)

      const res = await request(app).post(`${BASE}/fu1/recall`).send({})

      expect(res.status).toBe(409)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('is refused to anyone who is not an administrator', async () => {
      const res = await request(app).post(`${BASE}/fu1/recall`).send({})

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('does nothing to a closed follow-up', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row({ status: 'DEESCALATED' }) as never)

      const res = await request(app).post(`${BASE}/fu1/recall`).send({})

      expect(res.status).toBe(409)
    })
  })

  describe('GET /fuel/followups/:id/assignees', () => {
    it('lists the organisation\'s case holders, leaving out the deleter', async () => {
      asAdmin()
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row() as never)
      prismaMock.user.findMany.mockResolvedValue([{ id: 'tech', fullName: 'Tess Tech', email: 't@x' }] as never)

      const res = await request(app).get(`${BASE}/fu1/assignees`)

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([{ id: 'tech', fullName: 'Tess Tech', email: 't@x' }])
      expect(prismaMock.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: { notIn: ['deleter'] },
          status: { notIn: ['SUSPENDED', 'TERMINATED'] },
        }),
      }))
    })

    it('is for administrators only', async () => {
      const res = await request(app).get(`${BASE}/fu1/assignees`)

      expect(res.status).toBe(403)
    })
  })

  describe('POST /fuel/followups/:id/escalate', () => {
    const accepted = (by = ME) => row({ status: 'ACCEPTED', acceptedById: by, acceptedBy: person(by, by === ME ? 'Test User' : 'Otto') })

    it('closes it as a confirmed theft, logs the reason and labels the incident THEFT', async () => {
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(accepted() as never)
        .mockResolvedValueOnce(row({ ...accepted(), status: 'ESCALATED', resolvedAt: new Date() }) as never)
      prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/escalate`).send({ note: 'Driver admitted siphoning at the yard' })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('ESCALATED')
      expect(prismaMock.fuelTheftFollowUp.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'fu1', status: 'ACCEPTED', acceptedById: ME },
        data: expect.objectContaining({ status: 'ESCALATED' }),
      }))
      expect(prismaMock.fuelTheftFollowUpAction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ kind: 'ESCALATED', actorId: ME, note: 'Driver admitted siphoning at the yard' }),
      }))
      expect(prismaMock.fuelEventLabel.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ eventId: 'th1', eventType: 'THEFT', label: 'THEFT', labelledBy: 'test@fleet.dev' }),
      }))
      expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith({
        where: { id: 'th1' },
        data: expect.objectContaining({
          reviewStatus: 'CONFIRMED_THEFT', reviewedById: ME, reviewNote: 'Driver admitted siphoning at the yard',
        }),
      })
    })

    it('is reserved for the account that accepted it', async () => {
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(accepted('other') as never)

      const res = await request(app).post(`${BASE}/fu1/escalate`).send({ note: 'Looks like theft to me' })

      expect(res.status).toBe(403)
      expect(prismaMock.fuelTheftFollowUp.updateMany).not.toHaveBeenCalled()
    })

    it('needs the follow-up accepted first', async () => {
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(row() as never)

      const res = await request(app).post(`${BASE}/fu1/escalate`).send({ note: 'Looks like theft to me' })

      expect(res.status).toBe(409)
    })

    it('requires a reason', async () => {
      const res = await request(app).post(`${BASE}/fu1/escalate`).send({})

      expect(res.status).toBe(400)
      expect(prismaMock.fuelTheftFollowUp.findFirst).not.toHaveBeenCalled()
    })
  })

  describe('POST /fuel/followups/:id/deescalate', () => {
    it('closes it as not a theft and labels the incident NOT_THEFT', async () => {
      const accepted = row({ status: 'ACCEPTED', acceptedById: ME, acceptedBy: person(ME, 'Test User') })
      prismaMock.fuelTheftFollowUp.findFirst
        .mockResolvedValueOnce(accepted as never)
        .mockResolvedValueOnce({ ...accepted, status: 'DEESCALATED' } as never)
      prismaMock.user.findUnique.mockResolvedValue({ email: 'test@fleet.dev', fullName: 'Test User' } as never)
      prismaMock.fuelTheftFollowUp.updateMany.mockResolvedValue({ count: 1 })

      const res = await request(app).post(`${BASE}/fu1/deescalate`).send({ note: 'Probe recalibrated that morning' })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('DEESCALATED')
      expect(prismaMock.fuelEventLabel.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ label: 'NOT_THEFT' }),
      }))
      expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ reviewStatus: 'NOT_THEFT' }),
      }))
    })
  })

  describe('POST /fuel/followups/:id/notes', () => {
    it('logs a note from the owner', async () => {
      const accepted = row({ status: 'ACCEPTED', acceptedById: ME, acceptedBy: person(ME, 'Test User') })
      prismaMock.fuelTheftFollowUp.findFirst.mockResolvedValue(accepted as never)

      const res = await request(app).post(`${BASE}/fu1/notes`).send({ note: 'Called the driver, no answer' })

      expect(res.status).toBe(200)
      expect(prismaMock.fuelTheftFollowUpAction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ kind: 'NOTE', actorId: ME, note: 'Called the driver, no answer' }),
      }))
    })
  })

  describe('GET /fuel/thefts/outcomes', () => {
    it('totals alerts by what reviewers concluded, for analytics', async () => {
      const t = (reviewStatus: string | null, ml: number, vehicleId = 'v1', plate = 'MUFINDI - DZ 20') => ({
        vehicleId, stolenMl: ml, reviewStatus,
        dismissedAt: reviewStatus ? new Date('2026-09-24T10:00:00Z') : null,
        reviewedAt: reviewStatus ? new Date('2026-09-24T12:00:00Z') : null,
        vehicle: { registrationPlate: plate },
      })
      prismaMock.fuelTheft.findMany.mockResolvedValue([
        t(null, 10_000), t('CONFIRMED_THEFT', 23_500), t('CONFIRMED_THEFT', 6_500, 'v2', 'MUFINDI - EX 22'),
        t('NOT_THEFT', 4_000), t('DISMISSED', 5_000),
      ] as never)

      const res = await request(app).get(`/api/v1/organisations/${TEST_ORG_ID}/fuel/thefts/outcomes`)

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        total: 5,
        byStatus: {
          unreviewed: { count: 1, litres: 10 },
          CONFIRMED_THEFT: { count: 2, litres: 30 },
          NOT_THEFT: { count: 1, litres: 4 },
          DISMISSED: { count: 1, litres: 5 },
          UNDER_REVIEW: { count: 0, litres: 0 },
        },
        confirmedByVehicle: [
          { vehicleId: 'v1', count: 1, litres: 23.5 },
          { vehicleId: 'v2', count: 1, litres: 6.5 },
        ],
        medianHoursToDecision: 2,
      })
    })
  })
})
