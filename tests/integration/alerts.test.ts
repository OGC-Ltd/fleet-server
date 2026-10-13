/**
 * The Alerts page's two routes: the cross-organisation list
 * (GET /api/v1/alerts) and deciding an overspeeding episode
 * (POST /organisations/:orgId/incidents/speeding/:id/review). Fuel decisions
 * are fuel-review.test.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { Prisma } from '../../generated/prisma/client.js'
import { TEST_ORG_ID, testAuthUser } from '../helpers/factories.js'
import { authMock, authorizeMock, resetTestSubject } from '../helpers/auth-mock.js'
import type { Subject } from '../../src/lib/authz/subject.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

const who = vi.hoisted(() => ({ subject: null as unknown }))
vi.mock('../../src/lib/authz/subject.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSubject: vi.fn(async () => who.subject),
}))
const feed = vi.hoisted(() => ({ publish: vi.fn() }))
vi.mock('../../src/lib/notifications/notification.store.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishNotification: feed.publish,
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'
import { forgetAlertSummaries } from '../../src/modules/alerts/alerts.summary-cache.js'
import { fleetMidnight } from '../../src/modules/alerts/alerts.service.js'

let app: Express
beforeAll(async () => { app = await buildApp() })

const ME = testAuthUser.id

function subject(orgs: Record<string, string[]>): Subject {
  return {
    userId: ME,
    isPlatform: false,
    platformPermissions: new Set(),
    orgs: new Map(Object.entries(orgs).map(([id, perms]) => [id, { permissions: new Set(perms), vehicleIds: null }])),
  }
}

/** The SQL text and its flattened parameters, from a tagged $queryRaw call. */
function sqlOf(args: unknown[]) {
  const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]]
  return Prisma.sql(strings, ...(values as Prisma.Sql[]))
}

type Answers = { fuelCounts?: unknown[]; speedCounts?: unknown[]; fuel?: unknown[]; speeding?: unknown[] }
const calls: Array<{ text: string; values: unknown[] }> = []

function answer(a: Answers) {
  prismaMock.$queryRaw.mockImplementation(((...args: unknown[]) => {
    const q = sqlOf(args)
    calls.push({ text: q.sql, values: q.values })
    const counting = q.sql.includes('GROUP BY')
    if (q.sql.includes('FROM fuel_thefts')) return Promise.resolve((counting ? a.fuelCounts : a.fuel) ?? [])
    if (q.sql.includes('FROM speeding_incidents')) return Promise.resolve((counting ? a.speedCounts : a.speeding) ?? [])
    return Promise.resolve([])
  }) as never)
}

const fuelRow = (id: string, orgId: string, at: string, extra: Record<string, unknown> = {}) => ({
  id, orgId, vehicleId: `v-${id}`, plate: `PLATE ${id}`, vehicleName: null,
  at: new Date(at), detectedAt: new Date(at), stolenMl: 23_400, location: null,
  tankBeforeMl: 200_000, tankAfterMl: 176_600, cause: 'SIPHON', rule: 'fell-while-standing', confidence: 0.9,
  reviewStatus: null, reviewedAt: null, reviewNote: null, reviewedBy: null, dismissedAt: null,
  followUpStatus: null, driverName: null, ...extra,
})

const speedRow = (id: string, orgId: string, at: string, extra: Record<string, unknown> = {}) => ({
  id, orgId, vehicleId: `v-${id}`, plate: `PLATE ${id}`, vehicleName: null,
  at: new Date(at), endedAt: new Date(at), durationSec: 95, peakKmh: 104, avgKmh: 96,
  limitKmh: 80, limitSource: 'type', overByKmh: 24, frames: 4, distanceM: 2400, driverName: 'J. Driver',
  peakLat: null, peakLng: null, reviewStatus: null, reviewedAt: null, reviewNote: null, reviewedBy: null, ...extra,
})

beforeEach(() => {
  resetTestSubject()
  forgetAlertSummaries()
  calls.length = 0
  feed.publish.mockReset()
  who.subject = subject({
    org_a: ['fuel_theft:read', 'analytics:read'],
    org_b: ['fuel_theft:read'],
  })
  prismaMock.organisation.findMany.mockResolvedValue([
    { id: 'org_a', code: 'A', name: 'Alpha' }, { id: 'org_b', code: 'B', name: 'Beta' },
  ] as never)
  // An administrator in Alpha only.
  prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'admin', organisationId: 'org_a' } }] as never)
  prismaMock.user.findFirst.mockResolvedValue({ organisationId: 'org_a', memberships: [] } as never)
  prismaMock.alertDecision.findMany.mockResolvedValue([])
})

describe('GET /api/v1/alerts', () => {
  it('lists both kinds from every organisation, newest first, with who may decide where', async () => {
    answer({
      fuelCounts: [{ orgId: 'org_a', status: 'open', n: 1 }, { orgId: 'org_b', status: 'open', n: 1 }],
      speedCounts: [{ orgId: 'org_a', status: 'open', n: 1 }],
      fuel: [fuelRow('f1', 'org_a', '2026-10-12T10:00:00Z'), fuelRow('f2', 'org_b', '2026-10-12T08:00:00Z')],
      speeding: [speedRow('s1', 'org_a', '2026-10-12T09:00:00Z')],
    })

    const res = await request(app).get('/api/v1/alerts')

    expect(res.status).toBe(200)
    const body = res.body.data
    expect(body.data.map((r: { id: string }) => r.id)).toEqual(['f1', 's1', 'f2'])
    expect(body.orgs).toEqual([
      { id: 'org_a', code: 'A', name: 'Alpha', kinds: ['fuel', 'speeding'], canDecide: true },
      { id: 'org_b', code: 'B', name: 'Beta', kinds: ['fuel'], canDecide: false },
    ])
    expect(body.counts).toContainEqual({ orgId: 'org_b', status: 'open', n: 1, kind: 'fuel' })
    expect(body.data[0]).toMatchObject({
      kind: 'fuel', status: 'open', decision: null,
      choices: [
        { outcome: 'ESCALATED', reason: 'theft' },
        { outcome: 'ESCALATED', reason: 'probe_fault' },
        { outcome: 'DEESCALATED', reason: null },
      ],
      fuel: { litres: 23.4, tankBeforeL: 200, tankAfterL: 176.6 },
    })
    expect(body.data[1]).toMatchObject({
      kind: 'speeding', speeding: { peakKmh: 104, limitKmh: 80, overByKmh: 24 },
      choices: [{ outcome: 'ESCALATED', reason: null }, { outcome: 'DEESCALATED', reason: null }],
    })
    // Speeding is read only where analytics:read is held: Alpha, never Beta.
    const speedingRead = calls.find((c) => c.text.includes('FROM speeding_incidents') && c.text.includes('LIMIT'))!
    expect(speedingRead.values).toContain('org_a')
    expect(speedingRead.values).not.toContain('org_b')
  })

  it('puts the alert that arrived last on top, not the one that began last', async () => {
    answer({
      // A fall that began at 01:15 and was only called at 04:30…
      fuel: [fuelRow('f-late', 'org_a', '2026-10-13T01:15:00Z', { detectedAt: new Date('2026-10-13T04:30:00Z') })],
      // …and an overspeed from 04:00 to 04:14.
      speeding: [speedRow('s-new', 'org_a', '2026-10-13T04:00:00Z', { endedAt: new Date('2026-10-13T04:14:00Z') })],
    })

    const res = await request(app).get('/api/v1/alerts')

    expect(res.body.data.data.map((r: { id: string }) => r.id)).toEqual(['f-late', 's-new'])
    expect(res.body.data.data[0]).toMatchObject({ at: '2026-10-13T01:15:00.000Z', arrivedAt: '2026-10-13T04:30:00.000Z' })
    expect(res.body.data.data[1]).toMatchObject({ arrivedAt: '2026-10-13T04:14:00.000Z' })
    // Each kind is read off the database in the same order, and pages on it.
    const fuelRead = calls.find((c) => c.text.includes('FROM fuel_thefts') && c.text.includes('LIMIT'))!
    expect(fuelRead.text).toContain('ORDER BY t.detected_at DESC')
    const speedingRead = calls.find((c) => c.text.includes('FROM speeding_incidents') && c.text.includes('LIMIT'))!
    expect(speedingRead.text).toContain('ORDER BY s.ended_at DESC')
  })

  it('lets the platform administrator decide everywhere, and an administrator only where a member', async () => {
    answer({})
    prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'super_admin', organisationId: null } }] as never)
    let res = await request(app).get('/api/v1/alerts')
    expect(res.body.data.orgs.map((o: { canDecide: boolean }) => o.canDecide)).toEqual([true, true])

    // Holds `admin` in Beta, but is no longer a member there.
    prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'admin', organisationId: 'org_b' } }] as never)
    prismaMock.user.findFirst.mockResolvedValue({ organisationId: 'org_a', memberships: [] } as never)
    res = await request(app).get('/api/v1/alerts')
    expect(res.body.data.orgs.map((o: { canDecide: boolean }) => o.canDecide)).toEqual([false, false])
  })

  it('narrows to the organisations asked for, and never beyond what the person holds', async () => {
    answer({ fuel: [fuelRow('f2', 'org_b', '2026-10-12T08:00:00Z')] })

    const res = await request(app).get('/api/v1/alerts?orgs=org_b,org_elsewhere')

    expect(res.status).toBe(200)
    const fuelRead = calls.find((c) => c.text.includes('FROM fuel_thefts') && c.text.includes('LIMIT'))!
    expect(fuelRead.values).toContain('org_b')
    expect(fuelRead.values).not.toContain('org_a')
    expect(fuelRead.values).not.toContain('org_elsewhere')
    // Beta holds no speeding, so none is read.
    expect(calls.some((c) => c.text.includes('FROM speeding_incidents') && c.text.includes('LIMIT'))).toBe(false)
  })

  it('reads nothing for somebody with no alert permission anywhere', async () => {
    who.subject = subject({ org_a: ['map:read'] })
    answer({})

    const res = await request(app).get('/api/v1/alerts')

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ orgs: [], data: [], hasNextPage: false })
    expect(calls.filter((c) => c.text.includes('fuel_thefts') || c.text.includes('speeding_incidents'))).toEqual([])
  })

  it('shows a decision and its history, and offers only the other way', async () => {
    answer({
      fuel: [fuelRow('f1', 'org_a', '2026-10-12T10:00:00Z', {
        reviewStatus: 'NOT_THEFT', reviewedAt: new Date('2026-10-12T11:00:00Z'),
        reviewNote: 'Refuel mis-read', reviewedBy: 'Test User', dismissedAt: new Date('2026-10-12T11:00:00Z'),
      })],
    })
    prismaMock.alertDecision.findMany.mockResolvedValue([{
      kind: 'FUEL', alertId: 'f1', outcome: 'DEESCALATED', reason: null, note: 'Refuel mis-read',
      at: new Date('2026-10-12T11:00:00Z'), actor: { fullName: 'Test User' },
    }] as never)

    const res = await request(app).get('/api/v1/alerts?kind=fuel&status=deescalated')

    const row = res.body.data.data[0]
    expect(row).toMatchObject({
      status: 'deescalated',
      decision: { outcome: 'DEESCALATED', note: 'Refuel mis-read', by: 'Test User' },
      choices: [{ outcome: 'ESCALATED', reason: 'theft' }, { outcome: 'ESCALATED', reason: 'probe_fault' }],
    })
    expect(row.history).toHaveLength(1)
  })

  it('pages with a cursor, and counts only on the first page', async () => {
    answer({ fuel: [fuelRow('f1', 'org_a', '2026-10-12T10:00:00Z'), fuelRow('f0', 'org_a', '2026-10-12T09:00:00Z')] })

    const first = await request(app).get('/api/v1/alerts?kind=fuel&limit=1')
    expect(first.body.data).toMatchObject({ hasNextPage: true, cursor: `${Date.parse('2026-10-12T10:00:00Z')}.f1` })

    calls.length = 0
    const next = await request(app).get(`/api/v1/alerts?kind=fuel&limit=1&cursor=${first.body.data.cursor}`)
    expect(next.body.data.counts).toBeNull()
    expect(calls.some((c) => c.text.includes('GROUP BY'))).toBe(false)
  })

  it('refuses a malformed cursor and an upside-down range', async () => {
    answer({})
    expect((await request(app).get('/api/v1/alerts?cursor=nonsense')).status).toBe(400)
    expect((await request(app).get('/api/v1/alerts?from=2026-10-12&to=2026-10-01')).status).toBe(400)
  })
})

describe('GET /api/v1/alerts/summary', () => {
  it('counts the open alerts of both kinds over the page\'s default week', async () => {
    answer({
      fuelCounts: [{ orgId: 'org_a', status: 'open', n: 2 }, { orgId: 'org_b', status: 'escalated', n: 4 }],
      speedCounts: [{ orgId: 'org_a', status: 'open', n: 5 }, { orgId: 'org_a', status: 'deescalated', n: 1 }],
    })

    const res = await request(app).get('/api/v1/alerts/summary')

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      open: 7, fuel: 2, speeding: 5, from: fleetMidnight(Date.now(), 6).toISOString(),
    })
    // Counts only: no rows are read for a badge.
    expect(calls.every((c) => c.text.includes('GROUP BY'))).toBe(true)
  })

  it('answers again from memory for a minute, and counts afresh after a decision', async () => {
    answer({ fuelCounts: [{ orgId: 'org_a', status: 'open', n: 2 }] })
    await request(app).get('/api/v1/alerts/summary')
    const read = calls.length
    await request(app).get('/api/v1/alerts/summary')
    expect(calls.length).toBe(read)

    prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'admin' } }] as never)
    prismaMock.user.findFirst.mockResolvedValue({ id: ME } as never)
    prismaMock.speedingIncident.findFirst.mockResolvedValue({
      id: 'sp1', vehicleId: 'v1', reviewStatus: null, peakKmh: 100, limitKmh: 80, vehicle: { registrationPlate: 'KDE 585S' },
    } as never)
    prismaMock.speedingIncident.updateMany.mockResolvedValue({ count: 1 })
    await request(app).post(`/api/v1/organisations/${TEST_ORG_ID}/incidents/speeding/sp1/review`)
      .send({ outcome: 'DEESCALATED', note: 'GPS jump' })

    await request(app).get('/api/v1/alerts/summary')
    expect(calls.length).toBeGreaterThan(read)
  })

  it('is midnight on the fleet clock, not the server\'s', () => {
    // 01:30 in Nairobi on 12 Oct is 22:30 UTC on the 11th.
    expect(fleetMidnight(Date.parse('2026-10-11T22:30:00Z')).toISOString()).toBe('2026-10-11T21:00:00.000Z')
  })
})

describe('read marks', () => {
  it('lists whether this person has read each alert, and narrows to unread', async () => {
    const markedAt = new Date('2026-10-12T09:30:00Z')
    prismaMock.user.findUnique.mockResolvedValue({ alertsReadAt: markedAt } as never)
    answer({
      fuelCounts: [{ orgId: 'org_a', status: 'open', read: false, n: 1 }],
      fuel: [fuelRow('f1', 'org_a', '2026-10-12T10:00:00Z', { read: false })],
      speeding: [speedRow('s1', 'org_a', '2026-10-12T09:00:00Z', { read: true })],
    })

    const res = await request(app).get('/api/v1/alerts?read=unread')

    expect(res.status).toBe(200)
    expect(res.body.data.data.map((r: { id: string; read: boolean }) => [r.id, r.read])).toEqual([['f1', false], ['s1', true]])
    expect(res.body.data.counts).toContainEqual({ orgId: 'org_a', status: 'open', read: false, n: 1, kind: 'fuel' })
    const rows = calls.filter((c) => /FROM (fuel_thefts|speeding_incidents)/.test(c.text) && !c.text.includes('GROUP BY'))
    expect(rows).toHaveLength(2)
    // The caller's own marks, and everything that arrived by "Mark all read".
    expect(rows.every((c) => c.text.includes('FROM alert_reads') && c.values.includes(ME)
      && c.values.some((v) => v instanceof Date && v.getTime() === markedAt.getTime()))).toBe(true)
    expect(rows.every((c) => /AND NOT \(/.test(c.text))).toBe(true)
    expect(calls.find((c) => c.text.includes('FROM fuel_thefts'))!.text).toContain('t.detected_at <=')
    expect((await request(app).get('/api/v1/alerts?read=maybe')).status).toBe(400)
  })

  it('badges only the open alerts this person has not read', async () => {
    answer({
      fuelCounts: [{ orgId: 'org_a', status: 'open', read: false, n: 2 }, { orgId: 'org_a', status: 'open', read: true, n: 3 }],
      speedCounts: [{ orgId: 'org_a', status: 'open', read: true, n: 4 }],
    })

    const res = await request(app).get('/api/v1/alerts/summary')

    expect(res.body.data).toMatchObject({ open: 2, fuel: 2, speeding: 0 })
  })

  it('marks alerts read for the caller only, once each', async () => {
    prismaMock.alertRead.createMany.mockResolvedValue({ count: 2 })

    const res = await request(app).post('/api/v1/alerts/read')
      .send({ items: [{ kind: 'fuel', id: 'f1' }, { kind: 'speeding', id: 's1' }] })

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ marked: 2 })
    expect(prismaMock.alertRead.createMany).toHaveBeenCalledWith({
      data: [{ userId: ME, kind: 'FUEL', alertId: 'f1' }, { userId: ME, kind: 'SPEEDING', alertId: 's1' }],
      skipDuplicates: true,
    })
    expect((await request(app).post('/api/v1/alerts/read').send({ items: [] })).status).toBe(400)
  })

  it('marks everything so far read, and drops the single marks it covers', async () => {
    prismaMock.$transaction.mockResolvedValue([] as never)

    const res = await request(app).post('/api/v1/alerts/read-all')

    expect(res.status).toBe(200)
    const at = new Date(res.body.data.readAt)
    expect(prismaMock.user.update).toHaveBeenCalledWith({ where: { id: ME }, data: { alertsReadAt: at } })
    expect(prismaMock.alertRead.deleteMany).toHaveBeenCalledWith({ where: { userId: ME, readAt: { lte: at } } })
  })
})

describe('GET /api/v1/alerts/history', () => {
  it('counts every alert ever received, a fleet day at a time, both kinds', async () => {
    answer({
      fuelCounts: [{ orgId: 'org_a', day: '2026-09-28', n: 3 }],
      speedCounts: [{ orgId: 'org_a', day: '2026-09-28', n: 5 }, { orgId: 'org_b', day: '2026-10-12', n: 1 }],
    })

    const res = await request(app).get('/api/v1/alerts/history')

    expect(res.status).toBe(200)
    expect(res.body.data.days).toEqual([
      { orgId: 'org_a', day: '2026-09-28', n: 3, kind: 'fuel' },
      { orgId: 'org_a', day: '2026-09-28', n: 5, kind: 'speeding' },
      { orgId: 'org_b', day: '2026-10-12', n: 1, kind: 'speeding' },
    ])
    // Every state, from the start of time, on the fleet's clock.
    expect(calls.every((c) => c.text.includes('GROUP BY') && !c.text.includes('review_status'))).toBe(true)
    expect(calls.every((c) => c.text.includes("+ interval '3 hours'"))).toBe(true)
    expect(calls.some((c) => c.values.some((v) => v instanceof Date && v.getTime() === 0))).toBe(true)
  })
})

describe('POST /incidents/speeding/:id/review', () => {
  const URL = `/api/v1/organisations/${TEST_ORG_ID}/incidents/speeding/sp1/review`

  function asAdmin() {
    prismaMock.userRole.findMany.mockResolvedValue([{ role: { slug: 'admin' } }] as never)
    prismaMock.user.findFirst.mockResolvedValue({ id: ME } as never)
  }
  const episode = (reviewStatus: string | null = null) => ({
    id: 'sp1', vehicleId: 'v1', reviewStatus, peakKmh: 104.4, limitKmh: 80, vehicle: { registrationPlate: 'KDE 585S' },
  })

  it('escalates: the decision on the episode, in the log, and in the feed', async () => {
    asAdmin()
    prismaMock.speedingIncident.findFirst.mockResolvedValue(episode() as never)
    prismaMock.speedingIncident.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ fullName: 'Test User' } as never)

    const res = await request(app).post(URL).send({ outcome: 'ESCALATED', note: 'On the highway, no excuse' })

    expect(res.status).toBe(200)
    expect(res.body.data.review).toMatchObject({ status: 'ESCALATED', by: 'Test User', note: 'On the highway, no excuse' })
    expect(prismaMock.speedingIncident.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sp1', organisationId: TEST_ORG_ID },
    }))
    expect(prismaMock.speedingIncident.updateMany).toHaveBeenCalledWith({
      where: { id: 'sp1', reviewStatus: null },
      data: { reviewStatus: 'ESCALATED', reviewedAt: expect.any(Date), reviewedById: ME, reviewNote: 'On the highway, no excuse' },
    })
    expect(prismaMock.alertDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organisationId: TEST_ORG_ID, kind: 'SPEEDING', alertId: 'sp1', outcome: 'ESCALATED', actorId: ME }),
    })
    expect(feed.publish).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'SPEEDING_ESCALATED', plate: 'KDE 585S',
      text: expect.stringContaining('104 km/h where the limit is 80 km/h'),
    }))
  })

  it('de-escalates an escalated episode, without telling the feed', async () => {
    asAdmin()
    prismaMock.speedingIncident.findFirst.mockResolvedValue(episode('ESCALATED') as never)
    prismaMock.speedingIncident.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.user.findUnique.mockResolvedValue({ fullName: 'Test User' } as never)

    const res = await request(app).post(URL).send({ outcome: 'DEESCALATED', note: 'GPS jump on the bridge' })

    expect(res.status).toBe(200)
    expect(prismaMock.speedingIncident.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sp1', reviewStatus: 'ESCALATED' },
    }))
    expect(feed.publish).not.toHaveBeenCalled()
  })

  it('refuses the decision the episode already carries', async () => {
    asAdmin()
    prismaMock.speedingIncident.findFirst.mockResolvedValue(episode('ESCALATED') as never)
    const res = await request(app).post(URL).send({ outcome: 'ESCALATED', note: 'Again' })
    expect(res.status).toBe(409)
    expect(prismaMock.speedingIncident.updateMany).not.toHaveBeenCalled()
  })

  it('tells the second of two people deciding at once', async () => {
    asAdmin()
    prismaMock.speedingIncident.findFirst.mockResolvedValue(episode() as never)
    prismaMock.speedingIncident.updateMany.mockResolvedValue({ count: 0 })
    const res = await request(app).post(URL).send({ outcome: 'ESCALATED', note: 'Too fast' })
    expect(res.status).toBe(409)
    expect(prismaMock.alertDecision.create).not.toHaveBeenCalled()
  })

  it('is for administrators only', async () => {
    prismaMock.userRole.findMany.mockResolvedValue([] as never)
    const res = await request(app).post(URL).send({ outcome: 'ESCALATED', note: 'Too fast' })
    expect(res.status).toBe(403)
    expect(prismaMock.speedingIncident.updateMany).not.toHaveBeenCalled()
  })

  it('scopes the episode to the path organisation', async () => {
    asAdmin()
    prismaMock.speedingIncident.findFirst.mockResolvedValue(null)
    const res = await request(app).post(URL).send({ outcome: 'ESCALATED', note: 'Too fast' })
    expect(res.status).toBe(404)
  })

  it('requires an outcome and a reason', async () => {
    asAdmin()
    expect((await request(app).post(URL).send({ outcome: 'ESCALATED' })).status).toBe(400)
    expect((await request(app).post(URL).send({ outcome: 'SIDEWAYS', note: 'Too fast' })).status).toBe(400)
  })
})
