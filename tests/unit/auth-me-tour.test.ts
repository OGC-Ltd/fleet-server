/**
 * /auth/me carries the first-time tour version this person has been shown,
 * so the dashboard shows the tour once per account, not once per machine
 * (operator, 2026-10-09). An unreadable version must never cost a sign-in.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/authz/subject.js', () => ({
  resolveSubject: vi.fn(async () => ({ isPlatform: false, platformPermissions: new Set(), orgs: new Map() })),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { meHandler } from '../../src/modules/auth/auth.controller.js'

const USER = { id: 'u1', organisationId: 'o1', email: 'maya@example.test', fullName: 'Maya Okonkwo', status: 'ACTIVE' }

async function me() {
  const json = vi.fn()
  const res = { status: vi.fn(() => res), json } as never
  const next = vi.fn()
  await meHandler({ user: USER } as never, res, next)
  expect(next).not.toHaveBeenCalled()
  return json.mock.calls[0]![0].data.user
}

describe('GET /auth/me: the tour version', () => {
  it('carries the version the account has been shown', async () => {
    prismaMock.organisation.findMany.mockResolvedValue([] as never)
    prismaMock.user.findUnique.mockResolvedValue({ tourSeenVersion: 1 } as never)
    expect(await me()).toEqual({ ...USER, tourSeenVersion: 1 })
  })

  it('says null for never shown', async () => {
    prismaMock.organisation.findMany.mockResolvedValue([] as never)
    prismaMock.user.findUnique.mockResolvedValue({ tourSeenVersion: null } as never)
    expect((await me()).tourSeenVersion).toBeNull()
  })

  it('still signs the person in when the version cannot be read', async () => {
    prismaMock.organisation.findMany.mockResolvedValue([] as never)
    prismaMock.user.findUnique.mockRejectedValue(new Error('column "tour_seen_version" does not exist'))
    const user = await me()
    expect(user).toEqual(USER)
    expect('tourSeenVersion' in user).toBe(false)
  })
})
