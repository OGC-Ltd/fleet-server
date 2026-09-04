/**
 * The guard that keeps account administration off a bypassed server.
 *
 * Worth its own file because the failure it prevents is silent and severe: with
 * AUTH_BYPASS on, every request arrives as the bypass account, which on the
 * production box is a PLATFORM user — so every permission check passes and the
 * create-user, change-role and suspend routes become public.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted, because vi.mock's factory is lifted above ordinary top-level
// declarations and would otherwise read envMock before it exists.
const envMock = vi.hoisted(() => ({ AUTH_BYPASS: false }))
vi.mock('../../src/config/env.js', () => ({ env: envMock }))
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { requireRealAuth } from '../../src/middleware/requireRealAuth.js'

const run = () => {
  const next = vi.fn()
  requireRealAuth(
    { method: 'POST', baseUrl: '/api/v1/account', path: '/password' } as never,
    {} as never,
    next,
  )
  return next
}

beforeEach(() => { vi.clearAllMocks() })

describe('requireRealAuth', () => {
  it('passes through when authentication is real', () => {
    envMock.AUTH_BYPASS = false
    const next = run()
    expect(next).toHaveBeenCalledWith()
  })

  it('REFUSES while AUTH_BYPASS is on', () => {
    envMock.AUTH_BYPASS = true
    const next = run()

    const err = next.mock.calls[0]![0] as { statusCode: number; message: string }
    expect(err).toBeTruthy()
    expect(err.statusCode).toBe(403)
    // The message has to name the cause: a bare 403 on a route the operator
    // just deployed sends them hunting through role grants instead.
    expect(err.message).toMatch(/AUTH_BYPASS/)
  })
})
