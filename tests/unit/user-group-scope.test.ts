import { describe, it, expect, vi, beforeEach } from 'vitest'

const enforce = { on: false }
const findUnique = vi.fn()
const resolveSubject = vi.fn()

vi.mock('../../src/config/env.js', () => ({
  env: { get USER_GROUP_ENFORCE() { return enforce.on } },
}))
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}))
vi.mock('../../src/lib/authz/subject.js', () => ({
  resolveSubject: (...a: unknown[]) => resolveSubject(...a),
}))
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { groupScopeFor, prospectiveScope, groupWhere, groupCacheKey, UNSCOPED } =
  await import('../../src/modules/users/user-group.scope.js')

const ADMIN = 'user-admin'
const PLATFORM = 'user-sadmin'
const ORG = 'org-test'

beforeEach(() => {
  enforce.on = false
  findUnique.mockReset()
  resolveSubject.mockReset()
  resolveSubject.mockImplementation(async (id: string) => ({ isPlatform: id === PLATFORM }))
  findUnique.mockResolvedValue({ groups: [{ groupId: 'g-offgrid' }] })
})

describe('groupScopeFor — the flag', () => {
  it('does not narrow while USER_GROUP_ENFORCE is off', async () => {
    expect(await groupScopeFor(ADMIN, ORG)).toEqual(UNSCOPED)
    expect(findUnique).not.toHaveBeenCalled()
    expect(resolveSubject).not.toHaveBeenCalled()
  })

  it('narrows to all groups held by the caller once enforcement is on', async () => {
    enforce.on = true
    expect(await groupScopeFor(ADMIN, ORG)).toEqual({ unscoped: false, groupIds: ['g-offgrid'] })
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: {
        groups: {
          where: { group: { organisations: { some: { organisationId: ORG } } } },
          select: { groupId: true },
        },
      },
    }))
  })
})

describe('prospectiveScope — the rule itself', () => {
  it('leaves the platform administrator unscoped', async () => {
    expect(await prospectiveScope(PLATFORM, ORG)).toEqual(UNSCOPED)
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('scopes an ordinary admin to all their groups in stable order', async () => {
    findUnique.mockResolvedValue({
      groups: [{ groupId: 'g-kasulu' }, { groupId: 'g-offgrid' }, { groupId: 'g-kasulu' }],
    })
    expect(await prospectiveScope(ADMIN, ORG)).toEqual({
      unscoped: false,
      groupIds: ['g-kasulu', 'g-offgrid'],
    })
  })

  it('fails CLOSED for an admin with no group', async () => {
    findUnique.mockResolvedValue({ groups: [] })
    expect(await prospectiveScope(ADMIN, ORG)).toEqual({ unscoped: false, groupIds: [] })
  })

  it('fails CLOSED for an unidentified caller', async () => {
    expect(await prospectiveScope(undefined, ORG)).toEqual({ unscoped: false, groupIds: [] })
  })

  it('fails CLOSED when the caller row has gone', async () => {
    findUnique.mockResolvedValue(null)
    expect(await prospectiveScope(ADMIN, ORG)).toEqual({ unscoped: false, groupIds: [] })
  })
})

describe('groupWhere', () => {
  it('adds nothing to a query when unscoped', () => {
    expect(groupWhere(UNSCOPED)).toEqual({})
  })

  it('matches users sharing any group with the caller', () => {
    expect(groupWhere({ unscoped: false, groupIds: ['g-kasulu', 'g-offgrid'] })).toEqual({
      groups: { some: { groupId: { in: ['g-kasulu', 'g-offgrid'] } } },
    })
  })

  it('matches only other ungrouped users when the caller has no group', () => {
    expect(groupWhere({ unscoped: false, groupIds: [] })).toEqual({ groups: { none: {} } })
  })
})

describe('groupCacheKey', () => {
  it('keeps distinct scopes separate and independent of group ordering', () => {
    const multi = groupCacheKey({ unscoped: false, groupIds: ['g-offgrid', 'g-kasulu'] })
    expect(multi).toBe(groupCacheKey({ unscoped: false, groupIds: ['g-kasulu', 'g-offgrid'] }))
    expect(multi).not.toBe(groupCacheKey({ unscoped: false, groupIds: ['g-offgrid'] }))
  })

  it('separates unscoped, grouped and ungrouped scopes', () => {
    const keys = [
      groupCacheKey(UNSCOPED),
      groupCacheKey({ unscoped: false, groupIds: ['g-offgrid'] }),
      groupCacheKey({ unscoped: false, groupIds: [] }),
    ]
    expect(new Set(keys).size).toBe(3)
  })

  it('prefixes group IDs so they cannot collide with sentinel keys', () => {
    expect(groupCacheKey(UNSCOPED)).toBe('all')
    expect(groupCacheKey({ unscoped: false, groupIds: [] })).toBe('none')
    expect(groupCacheKey({ unscoped: false, groupIds: ['all'] })).not.toBe('all')
    expect(groupCacheKey({ unscoped: false, groupIds: ['none'] })).not.toBe('none')
  })
})
