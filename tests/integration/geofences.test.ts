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

let app: Express

beforeAll(async () => { app = await buildApp() })
const BASE = `/api/v1/organisations/${TEST_ORG_ID}/geofences`

const makeCircleFence = (overrides = {}) => ({
  id: 'gf_01', organisationId: TEST_ORG_ID,
  name: 'Nairobi CBD Zone',
  type: 'CIRCLE', mode: 'ALLOWLIST',
  centerLat: -1.2921, centerLng: 36.8219, radiusM: 5000,
  polygonCoords: null, isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
  ...overrides,
})

describe('POST /geofences', () => {
  it('creates a circle geofence', async () => {
    prismaMock.geofence.create.mockResolvedValue(makeCircleFence() as never)

    const res = await request(app).post(BASE).send({
      type: 'CIRCLE', name: 'Nairobi CBD Zone',
      centerLat: -1.2921, centerLng: 36.8219, radiusM: 5000,
    })

    expect(res.status).toBe(201)
    expect(res.body.data).toHaveProperty('type', 'CIRCLE')
  })

  it('returns 400 for circle missing radiusM', async () => {
    const res = await request(app).post(BASE).send({
      type: 'CIRCLE', name: 'Test', centerLat: -1.2921, centerLng: 36.8219,
    })
    expect(res.status).toBe(400)
  })

  it('creates a polygon geofence', async () => {
    const polygon = { ...makeCircleFence(), type: 'POLYGON', centerLat: null, centerLng: null, radiusM: null }
    prismaMock.geofence.create.mockResolvedValue(polygon as never)

    const res = await request(app).post(BASE).send({
      type: 'POLYGON', name: 'Custom Zone',
      polygonCoords: [[-1.3, 36.8], [-1.3, 36.9], [-1.2, 36.9]],
    })
    expect(res.status).toBe(201)
  })
})

describe('GET /geofences', () => {
  it('returns list', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([makeCircleFence()] as never)
    const res = await request(app).get(BASE)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})

describe('GET /geofences/:id', () => {
  it('returns 404 when not found', async () => {
    prismaMock.geofence.findFirst.mockResolvedValue(null)
    const res = await request(app).get(`${BASE}/gf_99`)
    expect(res.status).toBe(404)
  })
})

