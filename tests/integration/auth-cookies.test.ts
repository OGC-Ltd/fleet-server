/**
 * The cookie wiring, end to end through the real routes.
 *
 * Worth its own file because the details that make these cookies safe are all
 * invisible from the handler: the PATH scoping that keeps the refresh token off
 * ordinary API calls, httpOnly, and the fact that logout has to clear with the
 * same options it set with — a browser keys a cookie by name AND path, so
 * clearing at the wrong path leaves the real one in place and logout silently
 * does nothing.
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
  default: { hash: vi.fn(async () => '$2a$hashed'), compare: vi.fn(async () => true) },
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express
beforeAll(async () => { app = await buildApp() })

const USER = {
  id: 'usr_1', organisationId: 'org_a', email: 'ops@fleet.dev',
  fullName: 'Ops', status: 'ACTIVE', passwordHash: '$2a$hashed',
}

const cookiesOf = (res: { headers: Record<string, unknown> }): string[] =>
  (res.headers['set-cookie'] as string[] | undefined) ?? []

const named = (res: { headers: Record<string, unknown> }, name: string): string => {
  const hit = cookiesOf(res).find((c) => c.startsWith(`${name}=`))
  if (!hit) throw new Error(`No ${name} cookie in ${JSON.stringify(cookiesOf(res))}`)
  return hit
}

beforeEach(() => {
  vi.clearAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.user.findFirst as any).mockResolvedValue(USER)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.authSession.create as any).mockResolvedValue({ id: 'ses_1' })
})

describe('POST /auth/login', () => {
  it('sets both cookies', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: USER.email, password: 'correct-horse-battery' })

    expect(res.status).toBe(200)
    expect(named(res, 'fleet_at')).toBeTruthy()
    expect(named(res, 'fleet_rt')).toBeTruthy()
  })

  /**
   * The refresh cookie is scoped to the two endpoints that consume it, so it
   * does not ride along on the hundreds of ordinary API calls that have no
   * business seeing it. The access cookie is wider because SSE needs it.
   */
  it('scopes the refresh cookie to the auth endpoints alone', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: USER.email, password: 'correct-horse-battery' })

    expect(named(res, 'fleet_rt')).toContain('Path=/api/v1/auth')
    expect(named(res, 'fleet_at')).toContain('Path=/api/v1')
    expect(named(res, 'fleet_at')).not.toContain('Path=/api/v1/auth')
  })

  it('keeps both out of reach of page scripts', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: USER.email, password: 'correct-horse-battery' })

    for (const name of ['fleet_at', 'fleet_rt']) {
      expect(named(res, name)).toContain('HttpOnly')
      expect(named(res, name)).toContain('SameSite=Lax')
    }
  })

  it('also returns the tokens in the body, for callers with no cookie jar', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: USER.email, password: 'correct-horse-battery' })

    expect(res.body.data.accessToken).toBeTruthy()
    expect(res.body.data.refreshToken).toBeTruthy()
    // The hash must never leave the server.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash')
    expect(JSON.stringify(res.body)).not.toContain('$2a$')
  })

  it('refuses a bad password without setting anything', async () => {
    const bcrypt = (await import('bcryptjs')).default as unknown as { compare: ReturnType<typeof vi.fn> }
    bcrypt.compare.mockResolvedValueOnce(false)

    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: USER.email, password: 'wrong-but-long-enough' })

    expect(res.status).toBe(401)
    expect(cookiesOf(res)).toHaveLength(0)
  })

  it('refuses an account with no password the same way', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.user.findFirst as any).mockResolvedValue({ ...USER, passwordHash: null })
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: USER.email, password: 'correct-horse-battery' })

    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Invalid credentials')
  })
})

describe('POST /auth/refresh', () => {
  it('reads the token from the cookie, with no body at all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.findUnique as any).mockResolvedValue({
      id: 'ses_1', userId: USER.id, familyId: 'fam_1',
      expiresAt: new Date(Date.now() + 86_400_000), rotatedAt: null, revokedAt: null,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.updateMany as any).mockResolvedValue({ count: 1 })

    const res = await request(app).post('/api/v1/auth/refresh')
      .set('Cookie', 'fleet_rt=some-opaque-token')

    expect(res.status).toBe(200)
    expect(named(res, 'fleet_at')).toBeTruthy()
  })

  /**
   * A refused refresh means this browser's cookies are worthless — most often
   * because reuse was detected and the family was revoked. Leaving them in place
   * would have the client retry forever with a token that can only fail.
   */
  it('clears both cookies when it refuses', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.findUnique as any).mockResolvedValue(null)

    const res = await request(app).post('/api/v1/auth/refresh')
      .set('Cookie', 'fleet_rt=stale')

    expect(res.status).toBe(401)
    expect(named(res, 'fleet_at')).toMatch(/fleet_at=;/)
    expect(named(res, 'fleet_rt')).toMatch(/fleet_rt=;/)
  })
})

describe('POST /auth/logout', () => {
  it('needs no access token — it is reached when one has expired', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.findUnique as any).mockResolvedValue({ familyId: 'fam_1' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.updateMany as any).mockResolvedValue({ count: 1 })

    const res = await request(app).post('/api/v1/auth/logout')
      .set('Cookie', 'fleet_rt=some-opaque-token')

    expect(res.status).toBe(200)
  })

  it('clears at the SAME paths the cookies were set with', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.findUnique as any).mockResolvedValue(null)

    const res = await request(app).post('/api/v1/auth/logout')
    expect(named(res, 'fleet_rt')).toContain('Path=/api/v1/auth')
    expect(named(res, 'fleet_at')).toContain('Path=/api/v1')
  })

  it('succeeds with no cookie at all', async () => {
    const res = await request(app).post('/api/v1/auth/logout')
    expect(res.status).toBe(200)
  })
})
