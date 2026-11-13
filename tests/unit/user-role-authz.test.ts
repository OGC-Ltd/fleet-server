/**
 * Who may see accounts, grant roles and edit protected accounts.
 *
 * Until 2026-11-14 each of these was a role NAME in user.authz; since then
 * each is a right that STARTS on those roles (user:read_all on every role,
 * role:assign_senior and user:manage_protected on nobody but the System
 * Administrator), and IAM changes it per person.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { userRole: { findMany: (...args: unknown[]) => findMany(...args) } },
}))
const subjectMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/authz/subject.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/authz/subject.js')>()),
  resolveSubject: subjectMock,
}))

import {
  canEditUser,
  canManageRoleSlugs,
  canViewUser,
  visibleRoleSlugFor,
} from '../../src/modules/users/user.authz.js'
import { subjectFromRoles, type SubjectExtras } from '../helpers/subject-from-roles.js'

const ORG = 'org-test'

/** The actor's access from their roles (plus IAM changes). */
function actor(roles: string[], extras: SubjectExtras = {}) {
  subjectMock.mockResolvedValue(subjectFromRoles(ORG, roles, extras))
}

/** The target's role slugs, as the role lookup returns them. */
function target(...slugs: string[]) {
  findMany.mockReset()
  findMany.mockResolvedValue(slugs.map((slug) => ({ role: { slug } })))
}

beforeEach(() => { findMany.mockReset(); subjectMock.mockReset() })

describe('user visibility', () => {
  it('shows a supervisor every account now: user:read_all starts on every role', async () => {
    actor(['supervisor']); target('manager')
    await expect(canViewUser('supervisor-user', 'manager-user', ORG)).resolves.toBe(true)
    await expect(visibleRoleSlugFor('supervisor-user', ORG)).resolves.toBeNull()
  })

  it('limits somebody denied user:read_all to operator accounts', async () => {
    actor(['supervisor'], { deny: ['user:read_all'] })
    target('operator')
    await expect(canViewUser('s', 'operator-user', ORG)).resolves.toBe(true)
    target('manager')
    await expect(canViewUser('s', 'manager-user', ORG)).resolves.toBe(false)
    await expect(visibleRoleSlugFor('s', ORG)).resolves.toBe('operator')
  })
})

describe('granting roles', () => {
  it('lets admins grant only roles below admin, by default', async () => {
    actor(['admin'])
    await expect(canManageRoleSlugs('admin-user', ORG, ['operator'])).resolves.toBe(true)
    await expect(canManageRoleSlugs('admin-user', ORG, ['admin'])).resolves.toBe(false)
    await expect(canManageRoleSlugs('admin-user', ORG, ['director'])).resolves.toBe(false)
  })

  it('lets a holder of role:assign_senior grant Admin, never a platform role', async () => {
    actor(['admin'], { allow: ['role:assign_senior'] })
    await expect(canManageRoleSlugs('admin-user', ORG, ['admin', 'hos'])).resolves.toBe(true)
    await expect(canManageRoleSlugs('admin-user', ORG, ['director'])).resolves.toBe(false)
    await expect(canManageRoleSlugs('admin-user', ORG, ['super_admin'])).resolves.toBe(false)
  })

  it('refuses somebody without user:assign_role, and admits one given it', async () => {
    actor(['manager'])
    await expect(canManageRoleSlugs('m', ORG, ['operator'])).resolves.toBe(false)
    actor(['manager'], { allow: ['user:assign_role'] })
    await expect(canManageRoleSlugs('m', ORG, ['operator'])).resolves.toBe(true)
  })

  it('lets the System Administrator grant anything', async () => {
    actor(['super_admin'])
    await expect(canManageRoleSlugs('root-user', ORG, ['admin', 'director'])).resolves.toBe(true)
  })
})

describe('protected accounts', () => {
  it('protects admin, director and super-admin accounts from admin edits', async () => {
    actor(['admin'])
    for (const slug of ['admin', 'director', 'super_admin']) {
      target(slug)
      await expect(canEditUser('admin-user', 'target-user', ORG))
        .resolves.toEqual({ ok: false, blockedBy: slug })
    }
  })

  it('lets the System Administrator, or a holder of user:manage_protected, edit them', async () => {
    actor(['super_admin']); target('director')
    await expect(canEditUser('root-user', 'director-user', ORG)).resolves.toEqual({ ok: true })
    actor(['admin'], { allow: ['user:manage_protected'] }); target('director')
    await expect(canEditUser('admin-user', 'director-user', ORG)).resolves.toEqual({ ok: true })
  })
})
