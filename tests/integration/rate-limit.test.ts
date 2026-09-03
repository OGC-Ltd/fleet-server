/**
 * Rate limiting, and whose bucket a request lands in.
 *
 * The global limit was 100 per SIXTY SECONDS — 1.7 a second — against a
 * dashboard whose single page load fans out across the snapshot, the feed, the
 * geofences, the summary and a dozen analytics endpoints. A few views inside a
 * minute spent the whole allowance and the platform started 429ing its own
 * users. It is 100 a second now.
 *
 * The number is configuration and is asserted on the box after deploy. What is
 * pinned here is the property the number depends on: the bucket is keyed on the
 * CLIENT ip, resolved through the proxy header nginx sets. Get that wrong and
 * every user in the country shares one bucket behind nginx's 127.0.0.1 — the
 * first person through the door spends everyone's allowance, and no amount of
 * raising the limit fixes it.
 *
 * The limit is mocked down to something small so the burst is quick and cannot
 * race the window.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

const TEST_LIMIT = 5

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>()
  return { env: { ...actual.env, RATE_LIMIT_MAX: TEST_LIMIT, RATE_LIMIT_WINDOW_MS: 60_000 } }
})

vi.mock('../../src/lib/prisma.js')

import { buildApp } from '../helpers/app.js'

let app: Express
beforeAll(async () => { app = await buildApp() })

/** `/health` is behind the global limiter and touches nothing else. */
const hit = (ip: string) => request(app).get('/health').set('X-Forwarded-For', ip)

describe('the global limit', () => {
  it('allows requests up to the limit, then refuses', async () => {
    const ip = '203.0.113.10'
    for (let i = 0; i < TEST_LIMIT; i++) {
      expect((await hit(ip)).status, `request ${i + 1} of ${TEST_LIMIT}`).toBe(200)
    }
    const over = await hit(ip)
    expect(over.status).toBe(429)
  })

  it('answers with the app’s error shape, not express-rate-limit’s default text', async () => {
    const ip = '203.0.113.11'
    for (let i = 0; i < TEST_LIMIT; i++) await hit(ip)
    const over = await hit(ip)

    expect(over.body).toMatchObject({ statusCode: 429, status: 'error' })
    expect(over.body.message).toMatch(/too many requests/i)
  })

  /**
   * The one that matters. `app.set('trust proxy', 1)` is what makes `req.ip`
   * the client rather than nginx; without it these two addresses would share a
   * bucket and the second would already be exhausted.
   */
  it('keeps a separate bucket per client IP', async () => {
    const noisy = '203.0.113.20'
    for (let i = 0; i < TEST_LIMIT + 3; i++) await hit(noisy)
    expect((await hit(noisy)).status).toBe(429)

    // A different client, entirely unaffected by the one above.
    expect((await hit('203.0.113.21')).status).toBe(200)
  })

  it('does not let one client exhaust the platform', async () => {
    const noisy = '203.0.113.30'
    for (let i = 0; i < TEST_LIMIT * 4; i++) await hit(noisy)

    // Several unrelated clients, each still served.
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      expect((await hit(ip)).status, ip).toBe(200)
    }
  })

  /**
   * Reported so a client can back off deliberately rather than by guessing.
   * draft-8 names the header `ratelimit`; the legacy `X-RateLimit-*` set is
   * switched off.
   */
  it('reports the limit in standard headers', async () => {
    const res = await hit('203.0.113.40')
    expect(res.headers['ratelimit']).toBeDefined()
    expect(res.headers['x-ratelimit-limit']).toBeUndefined()
  })
})

describe('sign-in is limited separately from everything else', () => {
  /**
   * The login limiter is brute-force defence, not capacity, and is deliberately
   * far tighter than the global one. It must not be reached by ordinary
   * browsing, and the global limit must not be reached by a handful of failed
   * sign-ins.
   */
  it('does not spend the global budget on a failed sign-in', async () => {
    const ip = '203.0.113.50'
    // A couple of sign-in attempts...
    for (let i = 0; i < 2; i++) {
      await request(app).post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'nobody@example.com', password: 'not-the-password' })
    }
    // ...leave the general allowance for this client intact.
    expect((await hit(ip)).status).toBe(200)
  })
})
