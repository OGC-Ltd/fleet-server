import { describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'

vi.mock('../../src/config/env.js', () => ({ env: { AUTHZ_ENFORCE: true } }))
vi.mock('../../src/lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
const subjectFor = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../src/lib/authz/subject.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/authz/subject.js')>()),
  resolveSubject: vi.fn(async () => subjectFor.current),
}))

import { requireAnyPermission } from '../../src/middleware/authorize.js'

describe('requireAnyPermission', () => {
  const subject = (permissions: string[]) => ({
    userId: 'user-1',
    isPlatform: false,
    platformPermissions: new Set<string>(),
    orgs: new Map([['org-1', { permissions: new Set(permissions), vehicleIds: new Set<string>() }]]),
  })

  async function check(permissions: string[]) {
    subjectFor.current = subject(permissions)
    const request = {
      user: { id: 'user-1' },
      params: { orgId: 'org-1' },
      method: 'POST',
      baseUrl: '/api/v1/organisations/org-1',
      path: '/reports/document.pdf',
    } as unknown as Request
    let error: unknown
    await new Promise<void>((resolve) => {
      requireAnyPermission(['telemetry:read', 'user:read'])(request, {} as never, (err) => {
        error = err
        resolve()
      })
    })
    return { request, error }
  }

  it('allows a user-read-only account and attaches its organisation scope', async () => {
    const { request, error } = await check(['user:read'])
    expect(error).toBeUndefined()
    expect(request.authz).toMatchObject({ userId: 'user-1', orgId: 'org-1' })
  })

  it('keeps telemetry readers eligible and denies users with neither permission', async () => {
    expect((await check(['telemetry:read'])).error).toBeUndefined()
    expect((await check([])).error).toMatchObject({
      message: 'Missing permission: telemetry:read or user:read',
    })
  })

  it('requires at least one configured permission', () => {
    expect(() => requireAnyPermission([])).toThrow('at least one permission')
  })
})
