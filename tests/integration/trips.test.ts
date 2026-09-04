import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { makeTrip, TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')

vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })


const BASE = `/api/v1/organisations/${TEST_ORG_ID}/trips`

const validTripBody = {
  vehicleId: 'clv1234567890abcdefghijklm',
  reportingPeriodId: 'clp1234567890abcdefghijklm',
  beganAt: '2026-06-01T08:00:00Z',
  endedAt: '2026-06-01T09:00:00Z',
  durationSeconds: 3600,
  mileageKm: 120.5,
}

describe('GET /trips', () => {
  it('returns cursor-paginated trips', async () => {
    const trips = [makeTrip(), makeTrip()]
    prismaMock.trip.findMany.mockResolvedValue(trips as never)

    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('success')
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.meta).toHaveProperty('hasNextPage')
  })

  it('supports cursor and limit params', async () => {
    prismaMock.trip.findMany.mockResolvedValue([])

    const res = await request(app).get(BASE).query({ cursor: 'some_cursor', limit: '10' })

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })
})

describe('POST /trips', () => {
  it('creates trip and returns 201', async () => {
    const trip = makeTrip({ id: 't1' })
    prismaMock.trip.create.mockResolvedValue(trip)

    const res = await request(app).post(BASE).send(validTripBody)

    expect(res.status).toBe(201)
    expect(res.body.data.id).toBe('t1')
  })

  it('returns 400 for missing required fields', async () => {
    const res = await request(app).post(BASE).send({ vehicleId: 'v1' })

    expect(res.status).toBe(400)
    expect(res.body.errors).toBeDefined()
  })

  it('returns 400 for negative mileage', async () => {
    const res = await request(app).post(BASE).send({ ...validTripBody, mileageKm: -5 })

    expect(res.status).toBe(400)
  })
})

describe('GET /trips/:tripId', () => {
  it('returns 404 when trip not found', async () => {
    prismaMock.trip.findFirst.mockResolvedValue(null)

    const res = await request(app).get(`${BASE}/ghost`)
    expect(res.status).toBe(404)
  })
})
