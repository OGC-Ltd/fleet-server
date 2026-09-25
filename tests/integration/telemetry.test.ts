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


describe('GET /vehicles/:vehicleId/telemetry/day', () => {
  const day = '2026-06-29'
  const from = Date.parse('2026-06-28T21:00:00Z') // 00:00 EAT

  it('returns the day as columns, times in seconds after the start', async () => {
    prismaMock.vehicle.findFirst.mockResolvedValue({ id: 'veh_01' } as never)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([
      { ...ping, engineHoursMeter: 1200.1234 },
      { ...ping, capturedAt: new Date('2026-06-29T10:00:30Z'), engineOn: null, fuelLevelMl: null, engineHoursMeter: null },
    ] as never)

    const res = await request(app).get(`${BASE}/vehicles/veh_01/telemetry/day?day=${day}`)

    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d).toMatchObject({ day, from, count: 2, complete: true, truncated: false })
    expect(d.t).toEqual([(Date.parse('2026-06-29T10:00:00Z') - from) / 1000, (Date.parse('2026-06-29T10:00:30Z') - from) / 1000])
    expect(d.eng).toEqual([1, null])
    expect(d.fuelMl).toEqual([40000, null])
    expect(d.hrs).toEqual([1200.123, null])
    expect(d.lat[0]).toBe(-1.28639)
    expect(res.headers['cache-control']).toBe('private, max-age=86400')
  })

  it('reads only after `since` when it is inside the day', async () => {
    prismaMock.vehicle.findFirst.mockResolvedValue({ id: 'veh_01' } as never)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([] as never)
    const since = from + 3_600_000

    const res = await request(app).get(`${BASE}/vehicles/veh_01/telemetry/day?day=${day}&since=${since}`)

    expect(res.status).toBe(200)
    expect(res.body.data.since).toBe(since)
    const where = prismaMock.vehicleTelemetry.findMany.mock.calls.at(-1)![0]!.where as { capturedAt: unknown }
    expect(where.capturedAt).toEqual({ gt: new Date(since), lt: new Date(from + 86_400_000) })
  })

  it('refuses a malformed day and 404s a vehicle outside the org', async () => {
    expect((await request(app).get(`${BASE}/vehicles/veh_01/telemetry/day?day=29-06-2026`)).status).toBe(400)
    prismaMock.vehicle.findFirst.mockResolvedValue(null)
    expect((await request(app).get(`${BASE}/vehicles/veh_99/telemetry/day?day=${day}`)).status).toBe(404)
  })
})
