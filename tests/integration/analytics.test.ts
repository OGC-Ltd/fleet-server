import { describe, it, expect, vi, beforeAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID, testAuthUser } from '../helpers/factories.js'

vi.mock('../../src/lib/prisma.js')

vi.mock('../../src/middleware/auth.ts', () => ({
  authenticate: vi.fn((req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req['user'] = testAuthUser
    next()
  }),
  requireOrgAccess: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })
const BASE = `/api/v1/organisations/${TEST_ORG_ID}/analytics`

// groupBy has complex overloads that vitest-mock-extended can't infer — cast to any
const groupByMock = prismaMock.vehicleTelemetry.groupBy as unknown as {
  mockResolvedValue: (v: unknown) => void
}

describe('GET /analytics/overview', () => {
  it('returns fleet overview metrics', async () => {
    prismaMock.vehicle.count.mockResolvedValue(10)
    prismaMock.trip.count.mockResolvedValue(3)
    prismaMock.geofenceViolation.count.mockResolvedValue(1)
    groupByMock.mockResolvedValue([{ vehicleId: 'v1', _count: 1 }])

    const res = await request(app).get(`${BASE}/overview`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('totalVehicles', 10)
    expect(res.body.data).toHaveProperty('openViolations24h', 1)
  })
})

describe('GET /analytics/fuel-efficiency', () => {
  it('requires from and to params', async () => {
    const res = await request(app).get(`${BASE}/fuel-efficiency`)
    expect(res.status).toBe(400)
  })

  it('returns fuel data per vehicle', async () => {
    groupByMock.mockResolvedValue([
      { vehicleId: 'veh_01', _sum: { fuelUsedMl: 50_000 }, _count: { id: 100 } },
    ])
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'veh_01', registrationPlate: 'KCA 001X' }] as never)

    const res = await request(app)
      .get(`${BASE}/fuel-efficiency`)
      .query({ from: '2026-06-01', to: '2026-06-30' })

    expect(res.status).toBe(200)
    expect(res.body.data[0]).toHaveProperty('registrationPlate', 'KCA 001X')
    expect(res.body.data[0]).toHaveProperty('totalFuelMl', 50_000)
  })
})

describe('GET /analytics/fuel-cost', () => {
  const filling = (filledAt: Date, filledMl: number) => ({
    vehicleId: 'veh_01', filledAt, filledMl,
    vehicle: { registrationPlate: 'KDL 201X', name: 'SINO ZZ4257V344JB1R' },
  })

  /**
   * An explicit `to` is what makes the aggregate assertable against mocked
   * rows — but it does NOT bypass the cache, it just keys a different entry,
   * and the entry outlives the test that filled it.
   *
   * So every test here needs its OWN `to`. Sharing one meant the second test's
   * 10 L of mocked filling was never read: it got the 40 L the first test had
   * already warmed, asserted 8,000 against an expected 2,000, and had been
   * failing for exactly that reason. `pricePerLitre` cannot save it — price is
   * deliberately applied per request and never enters the key, so one entry
   * serves every rate.
   */
  const query = (to: string) => ({ days: '2', to })

  it('costs the ledger at the configured rate', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([
      filling(new Date('2026-08-03T09:00:00Z'), 40_000),
    ] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)

    const res = await request(app).get(`${BASE}/fuel-cost`).query(query('2026-08-03T12:00:00Z'))

    expect(res.status).toBe(200)
    expect(res.body.data.totals.litresFilled).toBe(40)
    expect(res.body.data.totals.cost).toBeGreaterThan(0)
    expect(res.body.data.price).toHaveProperty('source', 'configured')
    // One entry per window day, zero-filled.
    expect(res.body.data.byDay).toHaveLength(2)
    expect(res.body.data.byVehicle[0]).toHaveProperty('registrationPlate', 'KDL 201X')
  })

  it('honours a caller-supplied price', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([
      filling(new Date('2026-08-03T09:00:00Z'), 10_000),
    ] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)

    const res = await request(app).get(`${BASE}/fuel-cost`).query({ ...query('2026-08-03T13:00:00Z'), pricePerLitre: '200' })

    expect(res.status).toBe(200)
    expect(res.body.data.price).toMatchObject({ pricePerLitre: 200, source: 'request' })
    expect(res.body.data.totals.cost).toBe(2000)   // 10 L × 200
  })

  it('rejects a non-positive price', async () => {
    const res = await request(app).get(`${BASE}/fuel-cost`).query({ ...query('2026-08-03T14:00:00Z'), pricePerLitre: '0' })
    expect(res.status).toBe(400)
  })
})

describe('GET /analytics/speeding', () => {
  it('requires from and to params', async () => {
    const res = await request(app).get(`${BASE}/speeding`)
    expect(res.status).toBe(400)
  })

  it('returns speeding events', async () => {
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([
      { vehicleId: 'veh_01', capturedAt: new Date(), speedKmh: 120, lat: -1.29, lng: 36.82 },
    ] as never)
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'veh_01', registrationPlate: 'KCA 001X' }] as never)

    const res = await request(app)
      .get(`${BASE}/speeding`)
      .query({ from: '2026-06-01', to: '2026-06-30', thresholdKmh: '80' })

    expect(res.status).toBe(200)
    expect(res.body.data[0].speedKmh).toBe(120)
  })
})

describe('GET /analytics/violation-heatmap', () => {
  it('returns violation coordinates', async () => {
    prismaMock.geofenceViolation.findMany.mockResolvedValue([
      { lat: -1.29, lng: 36.82, occurredAt: new Date(), geofenceId: 'gf_01', vehicleId: 'veh_01' },
    ] as never)

    const res = await request(app)
      .get(`${BASE}/violation-heatmap`)
      .query({ from: '2026-06-01', to: '2026-06-30' })

    expect(res.status).toBe(200)
    expect(res.body.data[0]).toHaveProperty('lat')
    expect(res.body.data[0]).toHaveProperty('lng')
  })
})
