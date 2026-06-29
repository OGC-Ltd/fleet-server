import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID } from '../helpers/factories.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/sse.js', () => ({
  emitTelemetry: vi.fn(),
  emitViolation: vi.fn(),
  emitHeartbeat: vi.fn(),
  registerSseClient: vi.fn(() => vi.fn()),
}))

const mockIngestOrg = { id: TEST_ORG_ID, apiKeyId: 'key_01' }

vi.mock('../../src/middleware/ingestAuth.js', () => ({
  ingestAuth: vi.fn((req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req['ingestOrg'] = mockIngestOrg
    next()
  }),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })
const BASE = '/api/v1/ingest/telemetry'

const validPayload = {
  deviceId:   'DEV_001',
  capturedAt: '2026-06-29T10:00:00Z',
  lat:        -1.286389,
  lng:        36.817223,
  speedKmh:   60,
  engineOn:   true,
  fuelLevelMl: 40_000,
}

describe('POST /ingest/telemetry', () => {
  it('accepts valid payload and returns 201 with telemetry id', async () => {
    prismaMock.vehicle.findFirst.mockResolvedValue({
      id: 'veh_01', organisationId: TEST_ORG_ID,
    } as never)
    prismaMock.vehicleAssignment.findFirst.mockResolvedValue(null)
    prismaMock.vehicleTelemetry.upsert.mockResolvedValue({ id: BigInt(1), vehicleId: 'veh_01', capturedAt: new Date(), speedKmh: 60, engineOn: true, fuelLevelMl: 40_000, lat: -1.286389, lng: 36.817223 } as never)
    prismaMock.vehicleGeofence.findMany.mockResolvedValue([])

    const res = await request(app).post(BASE).send(validPayload)

    expect(res.status).toBe(201)
    expect(res.body.status).toBe('success')
    expect(res.body.data).toHaveProperty('id')
  })

  it('returns 404 when device not registered in org', async () => {
    prismaMock.vehicle.findFirst.mockResolvedValue(null)

    const res = await request(app).post(BASE).send(validPayload)

    expect(res.status).toBe(404)
  })

  it('returns 400 on missing deviceId', async () => {
    const res = await request(app).post(BASE).send({ capturedAt: '2026-06-29T10:00:00Z' })
    expect(res.status).toBe(400)
  })
})

