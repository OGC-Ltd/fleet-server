/**
 * The account routes, through the real router and validation middleware.
 *
 * These assert the boundaries that the service tests cannot see, because they
 * are enforced before the service is reached:
 *
 *   · `.strict()` refusing a body that mentions `email` or `role`. Zod strips
 *     unknown keys by default, so without it the API would answer 200 to
 *     "also make me an admin" and silently do nothing — which reads to the
 *     caller exactly like it worked.
 *   · A wrong current password answering 400 and NOT 401. The dashboard's
 *     apiFetch retries a 401 through its refresh path and, on the second
 *     failure, calls onSessionLost. A 401 here would sign a user out of the
 *     whole app for mistyping their old password.
 *   · forgot-password answering identically whatever it finds, so it cannot be
 *     used to ask whether somebody has an account.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => null,
  getQueueRedis: () => null,
  isRedisConfigured: () => false,
  CACHE_DB: 0, QUEUE_DB: 1,
  disconnectRedis: async () => {},
}))
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn(async () => '$2a$new'),
    compare: vi.fn(async (plain: string) => plain === 'correct-horse-battery'),
  },
}))
vi.mock('../../src/lib/mailer/mailer.js', () => ({
  sendMail: vi.fn(async () => ({ sent: true })),
}))

// The public routes here share a 5-per-15-minutes bucket, which this file
// exhausts several times over. Throttling is pinned in rate-limit.test.ts;
// these tests are about what the routes DO, so the limiters are pass-through.
// Every export has to be listed — vi.mock replaces the module wholesale.
vi.mock('../../src/middleware/rateLimiter.js', () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next()
  return {
    globalLimiter: passthrough,
    authLimiter: passthrough,
    loginAccountLimiter: passthrough,
    passwordResetLimiter: passthrough,
    passwordResetIpLimiter: passthrough,
    setupLimiter: passthrough,
    setupIpLimiter: passthrough,
    sensitiveLimiter: passthrough,
    refreshLimiter: passthrough,
    refreshIpLimiter: passthrough,
    ingestLimiter: passthrough,
  }
})

import { authMock } from '../helpers/auth-mock.js'
vi.mock('../../src/middleware/auth.ts', () => ({
  ...authMock(),
  // The account service clears this user's cache entry after a rename.
  forgetUser: vi.fn(),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'
import { testAuthUser } from '../helpers/factories.js'

let app: Express
beforeAll(async () => { app = await buildApp() })

const USER = {
  id: testAuthUser.id,
  organisationId: testAuthUser.organisationId,
  email: 'ops@fleet.dev',
  fullName: 'Ops Person',
  status: 'ACTIVE',
  passwordHash: '$2a$existing',
}

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 0 } as never)
  prismaMock.passwordToken.create.mockResolvedValue({} as never)
})

describe('PATCH /api/v1/account/profile', () => {
  it('renames the caller', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ email: USER.email } as never)
    prismaMock.user.update.mockResolvedValue({ ...USER, fullName: 'New Name' } as never)

    const res = await request(app).patch('/api/v1/account/profile').send({ fullName: 'New Name' })

    expect(res.status).toBe(200)
    expect(res.body.data.user.fullName).toBe('New Name')
  })

  it('REFUSES a body that also carries an email', async () => {
    const res = await request(app)
      .patch('/api/v1/account/profile')
      .send({ fullName: 'New Name', email: 'someone-else@evil.test' })

    expect(res.status).toBe(400)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })

  it('REFUSES a body that also carries a role', async () => {
    const res = await request(app)
      .patch('/api/v1/account/profile')
      .send({ fullName: 'New Name', role: 'admin' })

    expect(res.status).toBe(400)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })

  it('refuses a status change too', async () => {
    const res = await request(app)
      .patch('/api/v1/account/profile')
      .send({ fullName: 'New Name', status: 'ACTIVE', organisationId: 'org_other' })

    expect(res.status).toBe(400)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/v1/account/password', () => {
  it('answers 400 — never 401 — for a wrong current password', async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER as never)

    const res = await request(app).patch('/api/v1/account/password').send({
      currentPassword: 'wrong-one', newPassword: 'a-brand-new-passphrase',
    })

    // The whole point: apiFetch replays a 401 through refresh and then signs
    // the user out. Mistyping a password must not do that.
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(400)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })

  it('rejects a new password under the length floor before touching the database', async () => {
    const res = await request(app).patch('/api/v1/account/password').send({
      currentPassword: 'correct-horse-battery', newPassword: 'short',
    })

    expect(res.status).toBe(400)
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/account/forgot-password', () => {
  it('answers identically for a known and an unknown address', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null as never)
    const unknown = await request(app).post('/api/v1/account/forgot-password').send({ email: 'nobody@example.test' })

    prismaMock.user.findFirst.mockResolvedValue(USER as never)
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)
    const known = await request(app).post('/api/v1/account/forgot-password').send({ email: USER.email })

    expect(unknown.status).toBe(known.status)
    // Byte-identical, not merely both-2xx: any difference is an oracle.
    expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(known.body))
  })

  it('creates no token for an address that does not exist', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null as never)

    await request(app).post('/api/v1/account/forgot-password').send({ email: 'nobody@example.test' })

    expect(prismaMock.passwordToken.create).not.toHaveBeenCalled()
  })

  it('rejects a malformed address', async () => {
    const res = await request(app).post('/api/v1/account/forgot-password').send({ email: 'not-an-email' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/account/setup/:token', () => {
  it('reports an unusable link as invalid rather than erroring', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)

    const res = await request(app).get('/api/v1/account/setup/some-token-that-is-long-enough')

    expect(res.status).toBe(200)
    expect(res.body.data.valid).toBe(false)
  })

  it('describes a live link so the screen can greet the person', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue({
      id: 't1', userId: USER.id, purpose: 'INVITE', expiresAt: new Date(Date.now() + 60_000),
      user: USER,
    } as never)

    const res = await request(app).get('/api/v1/account/setup/some-token-that-is-long-enough')

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ valid: true, fullName: 'Ops Person', purpose: 'INVITE' })
  })
})

describe('POST /api/v1/account/setup', () => {
  it('refuses a consumed link and writes nothing', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)

    const res = await request(app).post('/api/v1/account/setup').send({
      token: 'a-token-long-enough-to-pass', password: 'a-brand-new-passphrase',
    })

    expect(res.status).toBe(400)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
