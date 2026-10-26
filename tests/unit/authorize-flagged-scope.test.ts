import { describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'

vi.mock('../../src/config/env.js', () => ({ env: { AUTHZ_ENFORCE: false } }))
vi.mock('../../src/lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
const subjectFor = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../src/lib/authz/subject.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/authz/subject.js')>()),
  resolveSubject: vi.fn(async () => subjectFor.current),
}))

import { requirePermission } from '../../src/middleware/authorize.js'

const subject = (permissions: string[], vehicleIds: string[]) => ({
  userId: 'u1', isPlatform: false, platformPermissions: new Set<string>(),
  orgs: new Map([['org-m', { permissions: new Set(permissions), vehicleIds: new Set(vehicleIds) }]]),
})

async function scopeSeen(perms: string[]) {
  subjectFor.current = subject(perms, ['v1', 'v2'])
  const req = { user: { id: 'u1' }, params: { orgId: 'org-m' }, method: 'GET', baseUrl: '', path: '/' } as unknown as Request
  await new Promise<void>((done) => requirePermission('telemetry:read')(req, {} as never, () => done()))
  return req.authz?.vehicleIds ?? null
}

describe('vehicle scope in shadow mode', () => {
  it('limits a technician to their flagged units', async () => {
    expect([...(await scopeSeen(['telemetry:read', 'vehicle:flagged_only'])) ?? []]).toEqual(['v1', 'v2'])
  })

  it('still only logs a narrower membership for everyone else', async () => {
    expect(await scopeSeen(['telemetry:read'])).toBeNull()
  })
})
