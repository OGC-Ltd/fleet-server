import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'
import { __resetBandCache } from '../../src/modules/fuel/fuel-adjudication.service.js'

let app: Express
beforeAll(async () => { app = await buildApp() })

const BASE = `/api/v1/organisations/${TEST_ORG_ID}/fuel/signal-alerts`
const T0 = Date.parse('2026-09-20T06:00:00Z')

beforeEach(() => {
  __resetBandCache()
  prismaMock.vehicle.findFirst.mockResolvedValue({ id: 'veh_01', registrationPlate: 'KDA 123A' } as never)
  prismaMock.vehicle.findMany.mockResolvedValue([{
    id: 'veh_01', registrationPlate: 'KDA 123A', vehicleType: 'TRUCK', organisationId: TEST_ORG_ID,
    tankCapacityLitres: 400, organisation: { code: 'SUKARI' },
  }] as never)
  prismaMock.vehicleFuelRate.findMany.mockResolvedValue([] as never)
})

/** A parked truck, one fix every 10 s, with a 200 L fill in the middle. */
function fillRows() {
  return Array.from({ length: 240 }, (_, i) => ({
    capturedAt: new Date(T0 + i * 10_000),
    lat: -0.8234, lng: 34.3845, speedKmh: 0, engineOn: false, ignitionKnown: true,
    fuelLevelMl: Math.round((100 + Math.min(Math.max(i - 120, 0), 30) * (200 / 30)) * 1000),
  }))
}

describe('GET /fuel/signal-alerts/vehicles/:vehicleId', () => {
  it('runs the detector over stored telemetry and reports the fill', async () => {
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(fillRows() as never)
    const from = new Date(T0).toISOString()
    const to = new Date(T0 + 40 * 60_000).toISOString()

    const res = await request(app).get(`${BASE}/vehicles/veh_01?from=${from}&to=${to}`)

    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d).toMatchObject({ vehicleId: 'veh_01', plate: 'KDA 123A', truncated: false })
    // TRUCK, judged per km; tank 400 L scales rRefuel to max(15, 20).
    expect(d.profile).toMatchObject({ type: 'truck', workUnit: 'km', consumptionSource: 'table', tankCapacityL: 400 })
    expect(d.profile.thresholds.rRefuel).toBe(20)
    expect(d.events).toHaveLength(1)
    expect(d.events[0]).toMatchObject({ type: 'REFUEL', rule: 'window', workUnit: 'km' })
    expect(d.events[0].deltaFuelL).toBeGreaterThan(190)
    expect(d.stats.medianGapS).toBe(10)

    // Reads a warm-up before `from`, and only this vehicle.
    const where = prismaMock.vehicleTelemetry.findMany.mock.calls.at(-1)![0]!.where as { vehicleId: string; capturedAt: { gte: Date } }
    expect(where.vehicleId).toBe('veh_01')
    expect(where.capturedAt.gte.getTime()).toBe(T0 - 30 * 60_000)
  })

  it('takes a profile override', async () => {
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([] as never)
    const res = await request(app).get(`${BASE}/vehicles/veh_01?profile=generator&consumption=45`)
    expect(res.status).toBe(200)
    expect(res.body.data.profile).toMatchObject({ type: 'generator', reason: 'requested', consumption: 45, consumptionSource: 'caller' })
  })

  it('refuses a window over seven days, and 404s a vehicle outside the org', async () => {
    const long = await request(app).get(`${BASE}/vehicles/veh_01?from=2026-09-01T00:00:00Z&to=2026-09-10T00:00:00Z`)
    expect(long.status).toBe(400)
    prismaMock.vehicle.findFirst.mockResolvedValue(null)
    expect((await request(app).get(`${BASE}/vehicles/veh_99`)).status).toBe(404)
  })
})

describe('POST /fuel/signal-alerts/evaluate', () => {
  /** An IMU-equipped car: level swings hard while sloshing, then a real siphon. */
  const samples = Array.from({ length: 400 }, (_, i) => {
    const sloshing = i >= 50 && i < 150
    const taken = Math.min(Math.max(i - 250, 0), 60) * (20 / 60)
    return {
      t: new Date(T0 + i * 1000).toISOString(),
      fuelL: 45 - taken + (sloshing ? 15 * Math.sin(i) : 0),
      ax: sloshing ? 3 * Math.sin(i * 1.7) : 0.05, ay: sloshing ? 3 * Math.cos(i * 1.3) : 0, az: 9.81,
      speedKmh: 0, ignitionOff: true, work: 0,
    }
  })

  it('evaluates caller samples against a named profile', async () => {
    const res = await request(app).post(`${BASE}/evaluate`).send({ profile: 'car', samples })
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.vehicleId).toBeNull()
    expect(d.stats.motion.imu).toBe(400)
    expect(d.events.map((e: { type: string }) => e.type)).toEqual(['THEFT_SUSPECTED'])
  })

  it('needs a profile when no vehicle is given, and bounds the payload', async () => {
    expect((await request(app).post(`${BASE}/evaluate`).send({ samples })).status).toBe(400)
    expect((await request(app).post(`${BASE}/evaluate`).send({ profile: 'car', samples: [] })).status).toBe(400)
    expect((await request(app).post(`${BASE}/evaluate`).send({ profile: 'lorry', samples })).status).toBe(400)
  })

  it('resolves the profile from a vehicle on the vehicle route', async () => {
    const res = await request(app).post(`${BASE}/vehicles/veh_01/evaluate`).send({ samples: samples.slice(0, 20) })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ vehicleId: 'veh_01', profile: { type: 'truck', tankCapacityL: 400 } })
  })
})
