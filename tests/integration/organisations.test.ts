import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { makeOrg, TEST_ORG_ID, testAuthUser } from '../helpers/factories.js'

vi.mock('../../src/lib/prisma.js')

vi.mock('../../src/middleware/auth.ts', () => ({
  authenticate: vi.fn((_req: unknown, _res: unknown, next: () => void) => {
    (_req as Record<string, unknown>)['user'] = testAuthUser
    next()
  }),
  requireOrgAccess: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })


const BASE = '/api/v1/organisations'

describe('GET /organisations', () => {
  it('returns paginated org list', async () => {
    const orgs = [makeOrg(), makeOrg()]
    prismaMock.organisation.findMany.mockResolvedValue(orgs)
    prismaMock.organisation.count.mockResolvedValue(2)

    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('success')
    expect(res.body.meta.total).toBe(2)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('POST /organisations', () => {
  it('creates org and returns 201', async () => {
    const org = makeOrg({ name: 'New Corp', code: 'NC' })
    prismaMock.organisation.create.mockResolvedValue(org)

    const res = await request(app).post(BASE).send({ name: 'New Corp', code: 'NC' })

    expect(res.status).toBe(201)
    expect(res.body.data.code).toBe('NC')
  })

  it('returns 400 when body is invalid (missing code)', async () => {
    const res = await request(app).post(BASE).send({ name: 'X' })

    expect(res.status).toBe(400)
    expect(res.body.status).toBe('error')
    expect(res.body.errors).toBeDefined()
  })
})

describe('GET /organisations/:id', () => {
  it('returns 404 when org does not exist', async () => {
    prismaMock.organisation.findUnique.mockResolvedValue(null)

    const res = await request(app).get(`${BASE}/nonexistent`)

    expect(res.status).toBe(404)
    expect(res.body.status).toBe('error')
  })

  it('returns org when found', async () => {
    const org = makeOrg({ id: TEST_ORG_ID })
    prismaMock.organisation.findUnique.mockResolvedValue(org)

    const res = await request(app).get(`${BASE}/${TEST_ORG_ID}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(TEST_ORG_ID)
  })
})

describe('PATCH /organisations/:id', () => {
  it('updates org name', async () => {
    const org = makeOrg({ id: TEST_ORG_ID })
    prismaMock.organisation.findUnique.mockResolvedValue(org)
    prismaMock.organisation.update.mockResolvedValue({ ...org, name: 'Renamed' })

    const res = await request(app).patch(`${BASE}/${TEST_ORG_ID}`).send({ name: 'Renamed' })

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed')
  })
})
