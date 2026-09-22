/**
 * Who a group scope lets an administrator reach — and the cache key that keeps
 * two administrators apart.
 *
 * The cache test is the important one. The roster is cached in Redis under a
 * key with no caller dimension at all, so the moment the roster differs per
 * group, two admins in different groups share one entry and whichever asks
 * first serves the other their people. It is a 60-second window, it logs
 * nothing, and the wrong answer looks exactly like the right one. `groupWhere`
 * without `groupCacheKey` is that bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const enforce   = { on: false }
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

const ADMIN    = 'user-admin'
const PLATFORM = 'user-sadmin'

beforeEach(() => {
  enforce.on = false
  findUnique.mockReset()
  resolveSubject.mockReset()
  resolveSubject.mockImplementation(async (id: string) => ({ isPlatform: id === PLATFORM }))
  findUnique.mockResolvedValue({ groupId: 'g-offgrid' })
})

describe('groupScopeFor — the flag', () => {
  it('narrows nothing while USER_GROUP_ENFORCE is off', async () => {
    expect(await groupScopeFor(ADMIN)).toEqual(UNSCOPED)
  })

  it('does not even query while the flag is off', async () => {
    await groupScopeFor(ADMIN)
    expect(findUnique).not.toHaveBeenCalled()
    expect(resolveSubject).not.toHaveBeenCalled()
  })

  it('narrows to the caller\'s own group once it is on', async () => {
    enforce.on = true
    expect(await groupScopeFor(ADMIN)).toEqual({ unscoped: false, groupId: 'g-offgrid' })
  })
})

describe('prospectiveScope — the rule itself', () => {
  it('leaves the platform administrator unscoped', async () => {
    expect(await prospectiveScope(PLATFORM)).toEqual(UNSCOPED)
    // Their own group is never even read: the platform role reaches every
    // tenant, and scoping it is how an operator locks themselves out.
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('scopes an ordinary admin to their group', async () => {
    expect(await prospectiveScope(ADMIN)).toEqual({ unscoped: false, groupId: 'g-offgrid' })
  })

  it('fails CLOSED for an admin with no group', async () => {
    findUnique.mockResolvedValue({ groupId: null })
    expect(await prospectiveScope(ADMIN)).toEqual({ unscoped: false, groupId: null })
  })

  it('fails CLOSED for an unidentified caller, rather than seeing everything', async () => {
    expect(await prospectiveScope(undefined)).toEqual({ unscoped: false, groupId: null })
  })

  it('fails CLOSED when the caller\'s own row has gone', async () => {
    findUnique.mockResolvedValue(null)
    expect(await prospectiveScope(ADMIN)).toEqual({ unscoped: false, groupId: null })
  })
})

describe('groupWhere', () => {
  it('adds nothing to a query when unscoped', () => {
    expect(groupWhere(UNSCOPED)).toEqual({})
  })

  it('matches the group exactly', () => {
    expect(groupWhere({ unscoped: false, groupId: 'g-kasulu' })).toEqual({ groupId: 'g-kasulu' })
  })

  it('matches only OTHER ungrouped rows when the caller has no group', () => {
    // Not `{}` — that would be "see everything", which is the fail-OPEN bug.
    expect(groupWhere({ unscoped: false, groupId: null })).toEqual({ groupId: null })
  })
})

describe('groupCacheKey — two groups must never share a roster entry', () => {
  it('gives different keys to different groups', () => {
    const a = groupCacheKey({ unscoped: false, groupId: 'g-offgrid' })
    const b = groupCacheKey({ unscoped: false, groupId: 'g-kasulu' })
    expect(a).not.toBe(b)
  })

  it('separates unscoped, grouped and ungrouped from each other', () => {
    const keys = [
      groupCacheKey(UNSCOPED),
      groupCacheKey({ unscoped: false, groupId: 'g-offgrid' }),
      groupCacheKey({ unscoped: false, groupId: null }),
    ]
    expect(new Set(keys).size).toBe(3)
  })

  it('never lets a group id collide with the unscoped or ungrouped sentinels', () => {
    expect(groupCacheKey(UNSCOPED)).toBe('all')
    expect(groupCacheKey({ unscoped: false, groupId: null })).toBe('none')
    // A group whose id was literally "all" must NOT be handed the platform
    // administrator's roster. cuids cannot be that word, so a bare key would
    // have been safe by luck; the prefix makes it safe by construction.
    expect(groupCacheKey({ unscoped: false, groupId: 'all'  })).not.toBe(groupCacheKey(UNSCOPED))
    expect(groupCacheKey({ unscoped: false, groupId: 'none' }))
      .not.toBe(groupCacheKey({ unscoped: false, groupId: null }))
  })
})
