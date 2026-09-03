import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { makeUser, TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')

vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express

beforeAll(async () => { app = await buildApp() })


const BASE = `/api/v1/organisations/${TEST_ORG_ID}/users`

describe('GET /organisations/:orgId/users', () => {
  it('returns paginated user list', async () => {
    const users = [makeUser(), makeUser()]
    prismaMock.user.findMany.mockResolvedValue(users)
    prismaMock.user.count.mockResolvedValue(2)

    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(res.body.meta.total).toBe(2)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('POST /organisations/:orgId/users', () => {
  it('creates user and returns 201', async () => {
    const user = makeUser({ email: 'new@fleet.dev', fullName: 'New User' })
    prismaMock.user.create.mockResolvedValue(user)

    const res = await request(app)
      .post(BASE)
      .send({ fullName: 'New User', email: 'new@fleet.dev' })

    expect(res.status).toBe(201)
    expect(res.body.data.email).toBe('new@fleet.dev')
  })

  it('returns 400 for invalid email', async () => {
    const res = await request(app)
      .post(BASE)
      .send({ fullName: 'X', email: 'not-an-email' })

    expect(res.status).toBe(400)
    expect(res.body.errors).toHaveProperty('email')
  })
})

describe('DELETE /organisations/:orgId/users/:userId', () => {
  it('soft-deletes user and returns 204', async () => {
    const user = makeUser({ id: 'u1' })
    prismaMock.user.findFirst.mockResolvedValue(user as never)
    prismaMock.user.update.mockResolvedValue({ ...user, deletedAt: new Date() })

    const res = await request(app).delete(`${BASE}/u1`)

    expect(res.status).toBe(204)
  })

  it('returns 404 when user not found', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null)

    const res = await request(app).delete(`${BASE}/ghost`)

    expect(res.status).toBe(404)
  })
})
