/**
 * The trip and day reports are made on the server now: the dashboard asks for
 * a PDF and downloads it. These pin the three routes' contract — headers, the
 * picker's list, and what they refuse.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

const svc = vi.hoisted(() => ({
  getTripReportData: vi.fn(),
  getDayTrips: vi.fn(),
  getDayReportData: vi.fn(),
}))
vi.mock('../../src/modules/trips/trip-report.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...svc,
}))

import { buildApp } from '../helpers/app.js'

let app: Express
beforeAll(async () => { app = await buildApp() })
beforeEach(() => { for (const f of Object.values(svc)) f.mockReset() })

const BASE = `/api/v1/organisations/${TEST_ORG_ID}/vehicles/veh_01`
const T0 = Date.parse('2026-10-28T05:00:00Z')

/** The smallest report input the builder and the renderer accept. */
const input = (mode: 'trip' | 'day') => ({
  mode, generatedAt: T0, companyName: 'SUKARI', vehicle: { id: 'veh_01', plate: 'KCP 145P', type: null },
  dispatch: { externalId: null, serialNumber: null, kind: null, status: null, driverName: null, destination: null,
    dispatchedAt: T0, returnedAt: null, tonnageT: null, bags: null, cargoName: null },
  fromName: null, toName: null, window: { from: T0, to: T0 + 3_600_000, clipped: false }, day: { from: T0, to: T0 },
  yard: null, dest: null, arrivedAt: null, track: [], legTrack: [], map: null, altitude: [],
  fuel: { hasProbe: false, series: [], usedByCounterL: null, fillings: [], drains: [] },
  dashcam: { fitted: false, complete: true, alarms: [] }, escalatedThefts: [], speeding: [], harsh: [],
  zones: { timedOut: false, visits: [] }, weighments: [],
})

/** Collect a binary body: supertest leaves application/pdf unparsed otherwise. */
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

describe('GET /vehicles/:vehicleId/trip-report.pdf', () => {
  it('answers with the finished PDF, named for the plate and the day, without map tiles', async () => {
    svc.getTripReportData.mockResolvedValue(input('trip'))
    const res = await request(app).get(`${BASE}/trip-report.pdf?dispatch=d-1`).buffer(true).parse(binary)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toContain('Trip report KCP 145P 2026-10-28')
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
    expect(svc.getTripReportData).toHaveBeenCalledWith(TEST_ORG_ID, 'veh_01', 'd-1', { withMap: false })
  })
})

describe('GET /vehicles/:vehicleId/day-trips', () => {
  it("lists the day's trips for the picker", async () => {
    const trips = [{ n: 1, from: T0, to: T0 + 3_600_000, distanceM: 40_000, fromName: 'NAITIRI YARD', toName: 'RAIPLY', start: null, end: null, dispatch: 'd-1' }]
    svc.getDayTrips.mockResolvedValue(trips)
    const res = await request(app).get(`${BASE}/day-trips?day=2026-10-28`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(trips)
    expect(svc.getDayTrips).toHaveBeenCalledWith(TEST_ORG_ID, 'veh_01', '2026-10-28')
  })

  it('needs a day', async () => {
    const res = await request(app).get(`${BASE}/day-trips`)
    expect(res.status).toBe(400)
    expect(svc.getDayTrips).not.toHaveBeenCalled()
  })
})

describe('GET /vehicles/:vehicleId/day-report.pdf', () => {
  it('makes the whole day when no trip is named', async () => {
    svc.getDayReportData.mockResolvedValue(input('day'))
    const res = await request(app).get(`${BASE}/day-report.pdf?day=2026-10-28`).buffer(true).parse(binary)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toContain('Day report KCP 145P 2026-10-28')
    expect(svc.getDayReportData).toHaveBeenCalledWith(TEST_ORG_ID, 'veh_01', '2026-10-28', null)
  })

  it('makes one trip of the day', async () => {
    svc.getDayReportData.mockResolvedValue(input('trip'))
    const res = await request(app).get(`${BASE}/day-report.pdf?day=2026-10-28&trip=2`).buffer(true).parse(binary)
    expect(res.status).toBe(200)
    expect(svc.getDayReportData).toHaveBeenCalledWith(TEST_ORG_ID, 'veh_01', '2026-10-28', 2)
  })

  it('refuses a trip that is not a trip number', async () => {
    for (const trip of ['0', '-1', '1.5', 'abc']) {
      const res = await request(app).get(`${BASE}/day-report.pdf?day=2026-10-28&trip=${trip}`)
      expect(res.status, trip).toBe(400)
    }
    expect(svc.getDayReportData).not.toHaveBeenCalled()
  })
})
