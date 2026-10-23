/**
 * Who may delete whom — and the lookup that stopped anybody deleting anybody.
 *
 * ## The bug this was found through
 *
 * `deleteUser` resolved the target through `findById`, which matches on the
 * home-organisation COLUMN, while the roster that renders the delete button
 * lists anybody with a live MEMBERSHIP too. Measured on the live fleets: of 48
 * rows across the four organisations' rosters, 35 are people whose account
 * lives in another tenant, and on Mufindi it is all twelve. Every one of them
 * answered with a 404 about somebody plainly on screen.
 *
 * ## The rule on top of it
 *
 * The platform administrator and an organisation's administrator may delete;
 * only within an organisation they belong to; and an admin may not delete a
 * system administrator, the platform administrator or a director.
 * That last line is not a ladder of rank — it stops an administrator removing
 * the people whose accounts exist to hold them to account.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  user:     { findFirst: vi.fn(), findUnique: vi.fn() },
  userRole: { findMany: vi.fn() },
}))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))
const groupScope = vi.hoisted(() => ({ value: { unscoped: true } as { unscoped: boolean; groupIds?: string[] } }))
vi.mock('../../src/modules/users/user-group.scope.js', () => ({
  groupScopeFor: vi.fn(async () => groupScope.value),
}))

import { canDeleteUser, DELETER_ROLE_SLUGS } from '../../src/modules/users/user.authz.js'

const ORG = 'org-mufindi'

/** Role slugs for the actor, then for the target, in the order they're asked. */
function roles(actor: string[], target: string[] = []) {
  prismaMock.userRole.findMany.mockReset()
  prismaMock.userRole.findMany
    .mockResolvedValueOnce(actor.map((slug) => ({ role: { slug } })))
    .mockResolvedValueOnce(target.map((slug) => ({ role: { slug } })))
}

/** Membership answers, in the order they're asked (actor, then target). */
function members(...answers: boolean[]) {
  prismaMock.user.findFirst.mockReset()
  for (const a of answers) prismaMock.user.findFirst.mockResolvedValueOnce(a ? { id: 'u' } : null)
  prismaMock.user.findFirst.mockResolvedValue({ id: 'u' })
}

beforeEach(() => {
  prismaMock.userRole.findMany.mockReset()
  prismaMock.user.findFirst.mockReset()
  prismaMock.user.findUnique.mockReset()
  groupScope.value = { unscoped: true }
})

describe('who may delete at all', () => {
  it('lets an organisation administrator delete an ordinary account', () => {
    roles(['admin'], ['operator'])
    members(true, true)
    return expect(canDeleteUser('boss', 'op', ORG)).resolves.toEqual({ ok: true, platformAdmin: false })
  })

  it('allows an admin to delete a manager in their group', async () => {
    roles(['admin'], ['manager'])
    members(true, true)
    await expect(canDeleteUser('boss', 'target', ORG))
    .resolves.toEqual({ ok: true, platformAdmin: false })
  })

  it('lets the platform administrator delete without a membership of their own', () => {
    roles(['super_admin'], ['operator'])
    members(true) // the TARGET's membership; the actor's is never asked
    return expect(canDeleteUser('root', 'op', ORG)).resolves.toEqual({ ok: true, platformAdmin: true })
  })

  it.each(['manager', 'hos', 'fleet_manager', 'technician', 'operator', 'hr'])(
    'refuses %s, who does not administer the organisation', async (slug) => {
      // hr is in this list deliberately: it holds user:delete in the shipped
      // matrix, and the operator's rule names only the administrators.
      roles([slug], ['operator'])
      members(true, true)
      await expect(canDeleteUser('x', 'op', ORG)).resolves.toEqual({ ok: false, reason: 'wrong_role' })
    })

  it('refuses an admin of another organisation', async () => {
    roles(['admin'], ['operator'])
    members(false, true)
    await expect(canDeleteUser('boss', 'op', ORG)).resolves.toEqual({ ok: false, reason: 'not_a_member' })
  })

  it('refuses a target who is not in this organisation', async () => {
    // "Only users that belong to the same organisation", from the other side.
    roles(['admin'], ['operator'])
    members(true, false)
    await expect(canDeleteUser('boss', 'stranger', ORG)).resolves.toEqual({ ok: false, reason: 'not_a_member' })
  })
})

describe('what an admin may not delete', () => {
  it.each([
    ['super_admin',  'the platform administrator'],
    ['system_admin', 'a system administrator'],
    ['admin',        'a peer administrator'],
    ['director',     'a director'],
  ])('refuses %s (%s)', async (slug) => {
    roles(['admin'], [slug])
    members(true, true)
    await expect(canDeleteUser('boss', 'target', ORG))
      .resolves.toEqual({ ok: false, reason: 'protected', blockedBy: slug })
  })

  it('checks EVERY role the target holds, not just the first', async () => {
    // Somebody can be an operator and a director. Stopping at the first slug
    // would let the protection be bypassed by grant order.
    roles(['admin'], ['operator', 'director'])
    members(true, true)
    await expect(canDeleteUser('boss', 'target', ORG))
      .resolves.toEqual({ ok: false, reason: 'protected', blockedBy: 'director' })
  })

  it('does not bind the PLATFORM administrator', async () => {
    // There is nobody above them for the rule to protect.
    roles(['super_admin'], ['admin'])
    members(true)
    await expect(canDeleteUser('root', 'boss', ORG)).resolves.toEqual({ ok: true, platformAdmin: true })
  })

  it('still lets an admin delete an unremarkable account', async () => {
    roles(['admin'], ['technician', 'operator'])
    members(true, true)
    await expect(canDeleteUser('boss', 'tech', ORG))
      .resolves.toEqual({ ok: true, platformAdmin: false })
  })

  it('allows an admin to delete a manager in their group', async () => {
    roles(['admin'], ['manager'])
    members(true, true)
    await expect(canDeleteUser('boss', 'target', ORG))
      .resolves.toEqual({ ok: true, platformAdmin: false })
  })
})

describe('the role lookup', () => {
  it('asks only for roles granted HERE or platform-wide', async () => {
    // An `admin` of Kabras must not answer for Mufindi.
    roles(['admin'], ['operator'])
    members(true, true)
    await canDeleteUser('boss', 'op', ORG)
    const where = prismaMock.userRole.findMany.mock.calls[0][0].where
    expect(where.revokedAt).toBeNull()
    expect(where.role.OR).toEqual([{ organisationId: ORG }, { organisationId: null }])
  })

  it('names the two roles that may delete, and no others', () => {
    expect([...DELETER_ROLE_SLUGS].sort()).toEqual(['admin', 'super_admin'])
  })

  it('requires a shared group for an organisation admin, but not for super admin', async () => {
    groupScope.value = { unscoped: false, groupIds: ['group-a'] }
    roles(['admin'], ['operator'])
    members(true, true)
    prismaMock.user.findUnique.mockResolvedValue({ groups: [{ groupId: 'group-b' }] })
    await expect(canDeleteUser('boss', 'op', ORG))
      .resolves.toEqual({ ok: false, reason: 'other_group' })

    roles(['super_admin'], ['operator'])
    members(true)
    await expect(canDeleteUser('root', 'op', ORG))
      .resolves.toEqual({ ok: true, platformAdmin: true })
  })
})
