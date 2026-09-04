import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/sse.js', () => ({
  emitTelemetry:    vi.fn(),
  emitViolation:    vi.fn(),
  emitHeartbeat:    vi.fn(),
  registerSseClient: vi.fn(() => vi.fn()),
}))

vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })
const BASE = `/api/v1/organisations/${TEST_ORG_ID}`

const ping = {
  id: BigInt(1),
  vehicleId: 'veh_01',
  deviceId: 'DEV_001',
  driverId: null,
  capturedAt: new Date('2026-06-29T10:00:00Z'),
  receivedAt: new Date(),
  lat: -1.286389, lng: 36.817223,
  altitudeM: null, headingDeg: null, accuracyM: null,
  speedKmh: 60, engineOn: true, fuelLevelMl: 40_000, fuelUsedMl: null, cargoWeightKg: null,
}

describe('GET /vehicles/:vehicleId/telemetry', () => {
  it('returns paginated history', async () => {
    prismaMock.vehicle.findFirst.mockResolvedValue({ id: 'veh_01' } as never)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([ping] as never)

    const res = await request(app).get(`${BASE}/vehicles/veh_01/telemetry`)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.meta).toHaveProperty('hasNextPage')
  })

  it('returns 404 when vehicle not in org', async () => {
    prismaMock.vehicle.findFirst.mockResolvedValue(null)

    const res = await request(app).get(`${BASE}/vehicles/veh_99/telemetry`)
    expect(res.status).toBe(404)
  })
})

describe('GET /vehicles/:vehicleId/telemetry/latest', () => {
  it('returns latest ping', async () => {
    prismaMock.vehicle.findFirst.mockResolvedValue({ id: 'veh_01' } as never)
    prismaMock.vehicleTelemetry.findFirst.mockResolvedValue(ping as never)

    const res = await request(app).get(`${BASE}/vehicles/veh_01/telemetry/latest`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('vehicleId', 'veh_01')
  })
})

