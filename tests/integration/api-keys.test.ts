import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID, TEST_USER_ID, testAuthUser } from '../helpers/factories.js'

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
const BASE = `/api/v1/organisations/${TEST_ORG_ID}/api-keys`

const makeKey = (overrides = {}) => ({
  id: 'key_01', organisationId: TEST_ORG_ID,
  label: 'Controltech Webhook', isActive: true,
  createdAt: new Date(), expiresAt: null, lastUsedAt: null, createdById: TEST_USER_ID,
  ...overrides,
})

describe('POST /api-keys', () => {
  it('creates an API key and returns rawKey once', async () => {
    prismaMock.ingestApiKey.create.mockResolvedValue(makeKey() as never)

    const res = await request(app).post(BASE).send({ label: 'Controltech Webhook' })

    expect(res.status).toBe(201)
    expect(res.body.data).toHaveProperty('rawKey')
    expect(res.body.data.rawKey).toMatch(/^flt_/)
  })

  it('returns 400 for missing label', async () => {
    const res = await request(app).post(BASE).send({})
    expect(res.status).toBe(400)
  })
})

describe('GET /api-keys', () => {
  it('returns list without rawKey', async () => {
    prismaMock.ingestApiKey.findMany.mockResolvedValue([makeKey()] as never)

    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(res.body.data[0]).not.toHaveProperty('rawKey')
    expect(res.body.data[0]).not.toHaveProperty('keyHash')
  })
})

describe('POST /api-keys/:keyId/revoke', () => {
  it('marks key as inactive', async () => {
    prismaMock.ingestApiKey.findFirst.mockResolvedValue(makeKey() as never)
    prismaMock.ingestApiKey.update.mockResolvedValue(makeKey({ isActive: false }) as never)

    const res = await request(app).post(`${BASE}/key_01/revoke`)

    expect(res.status).toBe(200)
    expect(res.body.data.isActive).toBe(false)
  })

  it('returns 404 for unknown key', async () => {
    prismaMock.ingestApiKey.findFirst.mockResolvedValue(null)
    const res = await request(app).post(`${BASE}/key_99/revoke`)
    expect(res.status).toBe(404)
  })
})

