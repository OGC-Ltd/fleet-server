import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
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
const BASE = `/api/v1/organisations/${TEST_ORG_ID}/routes`

const makeRoute = (overrides = {}) => ({
  id: 'rte_01',
  organisationId: TEST_ORG_ID,
  name: 'Garissa â†’ Nairobi',
  originName: 'Garissa Depot',
  originLat: -0.4551, originLng: 39.6483,
  destinationName: 'Nairobi CBD Warehouse',
  destinationLat: -1.2921, destinationLng: 36.8219,
  distanceKm: 377,
  isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
  waypoints: [],
  ...overrides,
})

const validBody = {
  name: 'Garissa â†’ Nairobi',
  originName: 'Garissa Depot', originLat: -0.4551, originLng: 39.6483,
  destinationName: 'Nairobi CBD Warehouse', destinationLat: -1.2921, destinationLng: 36.8219,
}

describe('GET /routes', () => {
  it('returns routes list', async () => {
    prismaMock.route.findMany.mockResolvedValue([makeRoute()] as never)

    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})

describe('POST /routes', () => {
  it('creates route and returns 201', async () => {
    prismaMock.route.create.mockResolvedValue(makeRoute() as never)

    const res = await request(app).post(BASE).send(validBody)

    expect(res.status).toBe(201)
    expect(res.body.data).toHaveProperty('id')
  })

  it('returns 400 on missing name', async () => {
    const res = await request(app).post(BASE).send({ originLat: -0.4551 })
    expect(res.status).toBe(400)
  })
})

describe('GET /routes/:routeId', () => {
  it('returns 404 when not found', async () => {
    prismaMock.route.findFirst.mockResolvedValue(null)
    const res = await request(app).get(`${BASE}/missing_id`)
    expect(res.status).toBe(404)
  })

  it('returns route when found', async () => {
    prismaMock.route.findFirst.mockResolvedValue(makeRoute() as never)
    const res = await request(app).get(`${BASE}/rte_01`)
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Garissa â†’ Nairobi')
  })
})

describe('DELETE /routes/:routeId', () => {
  it('returns 404 when route does not belong to org', async () => {
    prismaMock.route.findFirst.mockResolvedValue(null)
    const res = await request(app).delete(`${BASE}/rte_01`)
    expect(res.status).toBe(404)
  })
})

