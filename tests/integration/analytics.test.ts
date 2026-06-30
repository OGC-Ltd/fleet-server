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
