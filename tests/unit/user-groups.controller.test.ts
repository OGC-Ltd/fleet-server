import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
const prospectiveScope = vi.fn()
const sendSuccess = vi.fn()

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { userGroup: { findMany: (...args: unknown[]) => findMany(...args) } },
}))
vi.mock('../../src/lib/authz/subject.js', () => ({
  can: vi.fn(),
  canReachOrg: vi.fn(),
  invalidateSubject: vi.fn(),
  resolveSubject: vi.fn(),
}))
vi.mock('../../src/modules/users/user-group.scope.js', () => ({
  groupScopeFor: vi.fn(),
  prospectiveScope: (...args: unknown[]) => prospectiveScope(...args),
}))
vi.mock('../../src/modules/users/roster.cache.js', () => ({
  invalidateRosterForUser: vi.fn(),
  invalidateRostersForUsers: vi.fn(),
}))
vi.mock('../../src/core/response/response.js', () => ({
  sendSuccess: (...args: unknown[]) => sendSuccess(...args),
}))

const { list } = await import('../../src/modules/users/user-groups.controller.js')

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([])
  prospectiveScope.mockReset()
  sendSuccess.mockReset()
})

function response() {
  return {} as Parameters<typeof list>[1]
}

describe('user group list visibility', () => {
  it('returns only groups the caller belongs to in the organisation', async () => {
    prospectiveScope.mockResolvedValue({ unscoped: false, groupIds: ['group-a'] })
    const req = {
      params: { orgId: 'org-a' },
      user: { id: 'user-a' },
    }

    await Reflect.apply(list, undefined, [req, response(), vi.fn()])

    expect(prospectiveScope).toHaveBeenCalledWith('user-a', 'org-a')
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organisations: { some: { organisationId: 'org-a' } },
        id: { in: ['group-a'] },
      },
    }))
  })

  it('returns no groups when the caller has no memberships', async () => {
    prospectiveScope.mockResolvedValue({ unscoped: false, groupIds: [] })
    const req = {
      params: { orgId: 'org-a' },
      user: { id: 'user-a' },
    }

    await Reflect.apply(list, undefined, [req, response(), vi.fn()])

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organisations: { some: { organisationId: 'org-a' } },
        id: { in: [] },
      },
    }))
  })

  it('keeps platform and global group lists unscoped', async () => {
    prospectiveScope.mockResolvedValue({ unscoped: true })
    const orgReq = {
      params: { orgId: 'org-a' },
      user: { id: 'platform-user' },
    }

    await Reflect.apply(list, undefined, [orgReq, response(), vi.fn()])
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { organisations: { some: { organisationId: 'org-a' } } },
    }))

    const globalReq = {
      params: {},
      user: { id: 'platform-user' },
    }
    await Reflect.apply(list, undefined, [globalReq, response(), vi.fn()])
    expect(prospectiveScope).toHaveBeenCalledTimes(1)
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: {} }))
  })
})
