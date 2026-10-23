import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { userRole: { findMany: (...args: unknown[]) => findMany(...args) } },
}))

import {
  canEditUser,
  canManageRoleSlugs,
  canViewUser,
  requireUserAdministrator,
  requireUserReader,
} from '../../src/modules/users/user.authz.js'

const ORG = 'org-test'

function grants(...sets: string[][]) {
  findMany.mockReset()
  for (const slugs of sets) {
    findMany.mockResolvedValueOnce(slugs.map((slug) => ({ role: { slug } })))
  }
}

beforeEach(() => findMany.mockReset())

describe('user visibility', () => {
  it('limits a supervisor to operator accounts', async () => {
    grants(['supervisor'], ['operator'])
    await expect(canViewUser('supervisor-user', 'operator-user', ORG)).resolves.toBe(true)

    grants(['supervisor'], ['manager'])
    await expect(canViewUser('supervisor-user', 'manager-user', ORG)).resolves.toBe(false)
  })

  it('does not apply the supervisor filter to a manager', async () => {
    grants(['supervisor', 'manager'])
    await expect(canViewUser('manager-user', 'any-user', ORG)).resolves.toBe(true)
    expect(findMany).toHaveBeenCalledTimes(1)
  })

  it('denies operators user-directory access', async () => {
    grants(['operator'])
    await expect(canViewUser('operator-user', 'target-user', ORG)).resolves.toBe(false)

    grants(['operator'])
    const next = vi.fn()
    await Reflect.apply(requireUserReader, undefined, [
      { user: { id: 'operator-user' }, params: { orgId: ORG } },
      {},
      next,
    ])
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
  })
})

describe('user mutations', () => {
  it('only allows admin and super admin roles to write users', async () => {
    grants(['manager'])
    const managerNext = vi.fn()
    await Reflect.apply(requireUserAdministrator, undefined, [
      { user: { id: 'manager-user' }, params: { orgId: ORG } },
      {},
      managerNext,
    ])
    expect(managerNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))

    grants(['admin'])
    const adminNext = vi.fn()
    await Reflect.apply(requireUserAdministrator, undefined, [
      { user: { id: 'admin-user' }, params: { orgId: ORG } },
      {},
      adminNext,
    ])
    expect(adminNext).toHaveBeenCalledWith()

    grants(['super_admin'])
    const platformNext = vi.fn()
    await Reflect.apply(requireUserAdministrator, undefined, [
      { user: { id: 'root-user' }, params: {} },
      {},
      platformNext,
    ])
    expect(platformNext).toHaveBeenCalledWith()
  })

  it('lets admins manage only roles below admin', async () => {
    grants(['admin'])
    await expect(canManageRoleSlugs('admin-user', ORG, ['operator'])).resolves.toBe(true)

    grants(['admin'])
    await expect(canManageRoleSlugs('admin-user', ORG, ['admin'])).resolves.toBe(false)

    grants(['admin'])
    await expect(canManageRoleSlugs('admin-user', ORG, ['director'])).resolves.toBe(false)

    grants(['super_admin'])
    await expect(canManageRoleSlugs('root-user', ORG, ['admin', 'director'])).resolves.toBe(true)
  })

  it('protects admin, director and super-admin accounts from admin edits', async () => {
    for (const slug of ['admin', 'director', 'super_admin']) {
      grants(['admin'], [slug])
      await expect(canEditUser('admin-user', 'target-user', ORG))
        .resolves.toEqual({ ok: false, blockedBy: slug })
    }

    grants(['super_admin'], ['director'])
    await expect(canEditUser('root-user', 'director-user', ORG)).resolves.toEqual({ ok: true })
  })
})
