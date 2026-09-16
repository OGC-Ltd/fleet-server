/**
 * Whose bucket a password-setup request lands in.
 *
 * ## The bug this pins
 *
 * `passwordResetLimiter` — five requests per fifteen minutes, keyed on the IP —
 * guarded all three public account routes. Two of those three are the emailed
 * set-password link: a GET to check it and a POST to use it. So a setup cost
 * two of the five, an office behind one NAT is one IP, and the third colleague
 * to open their invite was told they had made too many requests.
 *
 * It was not theoretical. On the box: 115 requests to /api/v1/account/setup,
 * 102 of them 429, every one from a single address — and those 102 were every
 * 429 the platform served.
 *
 * Two things fix it, and both are tested here because either alone is a
 * half-fix. Splitting the budgets stops a setup spending the mail allowance.
 * Keying on the machine stops colleagues spending each other's.
 *
 * ## What is deliberately NOT here
 *
 * No test asserts that login is per-machine, because it must not be — a device
 * id is the caller's to discard, so keying a brute-force defence on one is the
 * same as removing it. The last test in this file pins that, so a future
 * "finish the job" commit fails rather than quietly widens the login door.
 *
 * Limits are mocked down so a burst is quick and cannot race the window.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

const RESET_MAX    = 3   // per machine
const RESET_IP_MAX = 8   // per address, over the top
const SETUP_MAX    = 6   // per machine

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>()
  return {
    env: {
      ...actual.env,
      PASSWORD_RESET_RATE_LIMIT_MAX:    RESET_MAX,
      PASSWORD_RESET_IP_RATE_LIMIT_MAX: RESET_IP_MAX,
      SETUP_RATE_LIMIT_MAX:             SETUP_MAX,
      SETUP_IP_RATE_LIMIT_MAX:          1_000,
      // The global limiter must not be what answers any of these.
      RATE_LIMIT_MAX:                   10_000,
      LOGIN_RATE_LIMIT_MAX:             3,
    },
  }
})

vi.mock('../../src/lib/prisma.js')

import { buildApp } from '../helpers/app.js'

let app: Express
beforeAll(async () => { app = await buildApp() })

/**
 * One request from a named machine at a named address.
 *
 * The device id goes in as a header rather than a cookie because that is the
 * shape a test can state plainly; the middleware accepts either, and a browser
 * takes the cookie path. `X-Forwarded-For` is what `trust proxy` resolves
 * `req.ip` through.
 */
const from = (ip: string, device?: string) => ({
  setup: () => {
    const r = request(app)
      .get('/api/v1/account/setup/deadbeefdeadbeefdeadbeefdeadbeef')
      .set('X-Forwarded-For', ip)
    return device ? r.set('X-Device-Id', device) : r
  },
  forgot: () => {
    const r = request(app)
      .post('/api/v1/account/forgot-password')
      .set('X-Forwarded-For', ip)
      .send({ email: 'someone@example.com' })
    return device ? r.set('X-Device-Id', device) : r
  },
})

describe('the office NAT', () => {
  /**
   * The reported failure, reproduced end to end: several people setting their
   * passwords from one address. Before the split this ran out after two.
   */
  it('lets a whole office set their passwords from one address', async () => {
    const ip = '41.139.129.10'
    for (const who of ['laptop-a', 'laptop-b', 'laptop-c', 'laptop-d', 'laptop-e']) {
      // The real flow: check the link, then use it.
      expect((await from(ip, who).setup()).status, `${who} opening the link`).not.toBe(429)
      expect((await from(ip, who).setup()).status, `${who} submitting`).not.toBe(429)
    }
  })

  it('gives each machine its own budget, and does not let one spend another', async () => {
    const ip = '41.139.129.20'

    // One machine burns its whole allowance and then some.
    for (let i = 0; i < SETUP_MAX + 4; i++) await from(ip, 'greedy-pc').setup()
    expect((await from(ip, 'greedy-pc').setup()).status).toBe(429)

    // The desk next to it, same address, completely unaffected.
    expect((await from(ip, 'innocent').setup()).status).not.toBe(429)
  })

  it('still stops ONE machine running away', async () => {
    const ip = '41.139.129.30'
    for (let i = 0; i < SETUP_MAX; i++) {
      expect((await from(ip, 'runaway-pc').setup()).status, `request ${i + 1}`).not.toBe(429)
    }
    expect((await from(ip, 'runaway-pc').setup()).status).toBe(429)
  })
})

describe('the two budgets are separate', () => {
  /**
   * The direct cause. Opening an emailed link sends no mail and must not spend
   * the allowance for a route that does.
   */
  it('does not spend the reset-mail budget on opening a setup link', async () => {
    const ip = '41.139.129.40'
    for (let i = 0; i < SETUP_MAX; i++) await from(ip, 'desk-pc-1').setup()

    // The reset budget is untouched, all three of it.
    for (let i = 0; i < RESET_MAX; i++) {
      expect((await from(ip, 'desk-pc-1').forgot()).status, `reset ${i + 1}`).not.toBe(429)
    }
  })

  it('keeps the reset budget tight — it mails an address the caller chose', async () => {
    const ip = '41.139.129.50'
    for (let i = 0; i < RESET_MAX; i++) {
      expect((await from(ip, 'desk-pc-1').forgot()).status, `reset ${i + 1}`).not.toBe(429)
    }
    expect((await from(ip, 'desk-pc-1').forgot()).status).toBe(429)

    // ...and a spent reset budget does not block that machine from finishing a
    // setup it already has a link for.
    expect((await from(ip, 'desk-pc-1').setup()).status).not.toBe(429)
  })
})

describe('the per-IP ceiling', () => {
  /**
   * The honest case wins, and the dishonest one does not. A device id is minted
   * by the server but HELD BY THE CLIENT, so a caller can throw it away and ask
   * for a fresh bucket. This is the limiter that makes that pointless.
   */
  it('stops a caller minting fresh device ids to mint fresh budgets', async () => {
    const ip = '41.139.129.60'
    let blocked = false
    // Each request claims to be a brand-new machine. Per-machine alone would
    // allow this forever; the ceiling is RESET_IP_MAX.
    for (let i = 0; i < RESET_IP_MAX + 3; i++) {
      const res = await from(ip, `throwaway-${i}`).forgot()
      if (res.status === 429) { blocked = true; break }
    }
    expect(blocked, 'an id-rotating caller was never stopped').toBe(true)
  })

  it('sits above the per-machine limit, not below it — one machine meets its own first', async () => {
    const ip = '41.139.129.70'
    for (let i = 0; i < RESET_MAX; i++) {
      expect((await from(ip, 'single-pc').forgot()).status, `reset ${i + 1}`).not.toBe(429)
    }
    expect((await from(ip, 'single-pc').forgot()).status).toBe(429)

    // The ceiling has room left, which is what proves the 429 above came from
    // the machine limit and not from the address limit.
    expect((await from(ip, 'other-pc-1').forgot()).status).not.toBe(429)
  })
})

describe('what must stay per-IP', () => {
  /**
   * The load-bearing test in this file.
   *
   * Login is the only thing between an exposed endpoint and an offline-speed
   * password guess. Keying it per-machine would hand an attacker an unlimited
   * supply of buckets for the price of not sending a cookie. If someone extends
   * the per-machine key to login "for consistency", this fails.
   */
  it('does not give a new device id a fresh sign-in allowance', async () => {
    const ip = '41.139.129.80'
    const login = (device: string) =>
      request(app).post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip).set('X-Device-Id', device)
        .send({ email: 'nobody@example.com', password: 'not-the-password' })

    // Spend the address's whole sign-in allowance from one machine.
    for (let i = 0; i < 3; i++) await login('attacker-0')
    expect((await login('attacker-0')).status).toBe(429)

    // A "different machine" at the same address gets nothing extra.
    expect((await login('attacker-1')).status).toBe(429)
    expect((await login('attacker-2')).status).toBe(429)
  })
})

/**
 * `/health` deliberately does NOT issue one — the middleware is mounted on the
 * account and refresh routes rather than on the whole app, so that hardware
 * posting telemetry several hundred times a minute is not handed a cookie it
 * will never keep. These go through a route that actually reads it.
 */
const setupPath = '/api/v1/account/setup/deadbeefdeadbeefdeadbeefdeadbeef'

describe('the device cookie', () => {
  it('is issued to a caller that has none, so its NEXT request has its own bucket', async () => {
    const res = await request(app).get(setupPath).set('X-Forwarded-For', '41.139.129.90')
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined
    const did = (setCookie ?? []).find((c) => c.startsWith('fleet_did='))

    expect(did, 'no fleet_did issued').toBeDefined()
    expect(did).toMatch(/HttpOnly/i)
    expect(did).toMatch(/SameSite=Lax/i)
    // Scoped to the API, so it never rides on the dashboard's own assets.
    expect(did).toMatch(/Path=\/api\/v1/i)
  })

  it('does not re-issue one to a caller that already has a good id', async () => {
    const res = await request(app).get(setupPath)
      .set('X-Forwarded-For', '41.139.129.91')
      .set('Cookie', 'fleet_did=aGVsbG90aGVyZTEyMzQ1')
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined
    expect((setCookie ?? []).some((c) => c.startsWith('fleet_did='))).toBe(false)
  })

  /**
   * The bit that stops the cookie being a way around the limit.
   *
   * A client that never returns the cookie must NOT be handed a fresh bucket
   * every request — that would be an unlimited supply of them. Every such
   * caller shares one per-IP bucket instead, so it behaves exactly as it did
   * before any of this existed.
   */
  it('collapses cookieless callers into one shared bucket rather than minting them one each', async () => {
    const ip = '41.139.129.95'
    let blocked = false
    // No device header, no cookie jar — a fresh anonymous caller every time.
    for (let i = 0; i < SETUP_MAX + 4; i++) {
      const res = await request(app).get(setupPath).set('X-Forwarded-For', ip)
      if (res.status === 429) { blocked = true; break }
    }
    expect(blocked, 'a cookieless caller was never limited').toBe(true)
  })

  /**
   * A malformed id is replaced rather than trusted. Without this, a caller
   * could hand over a 10KB string, or one containing the `|` that composes the
   * key, and write into another machine's bucket.
   */
  it('replaces an id that is not well-formed', async () => {
    const res = await request(app).get(setupPath)
      .set('X-Forwarded-For', '41.139.129.92')
      .set('Cookie', 'fleet_did=' + encodeURIComponent('41.139.129.93|victim'))
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined
    expect((setCookie ?? []).some((c) => c.startsWith('fleet_did='))).toBe(true)
  })
})
