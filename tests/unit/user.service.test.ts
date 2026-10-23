import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError, ConflictError } from '../../src/core/errors/errors.js'

vi.mock('../../src/modules/users/user.repository.ts')
vi.mock('../../src/modules/users/user-group.scope.js', () => ({
  groupScopeFor: vi.fn(async () => ({ unscoped: true })),
  groupCacheKey: vi.fn(() => 'all'),
}))

import * as repo from '../../src/modules/users/user.repository.js'
import * as service from '../../src/modules/users/user.service.js'
import { makeUser, TEST_ORG_ID } from '../helpers/factories.js'

const mockRepo = vi.mocked(repo)

beforeEach(() => vi.clearAllMocks())

const ORG = TEST_ORG_ID

describe('user.service', () => {
  describe('getUser', () => {
    it('returns user when found in org', async () => {
      const user = makeUser({ id: 'u1' })
      mockRepo.findById.mockResolvedValue(user as never)

      const result = await service.getUser(ORG, 'u1')
      expect(result).toEqual(user)
    })

    it('throws NotFoundError when user missing', async () => {
      mockRepo.findById.mockResolvedValue(null)
      await expect(service.getUser(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  /*
   * The purge's own refusals, and one of them is a regression test.
   *
   * A VISITING MEMBER — somebody whose account lives in another organisation
   * but who holds a live membership here — is listed by the roster, so the
   * screen offers a delete against them. The service resolved them through
   * `findById`, which matches on the home organisation alone, so every one of
   * those attempts came back 404 "User not found" about a person plainly on
   * screen, and the explanatory refusal below was unreachable code.
   */
  describe('purgeUser', () => {
    const visitor = { id: 'u2', fullName: 'Visitor', email: 'v@x.com', organisationId: 'other-org' }
    const local   = { id: 'u3', fullName: 'Local',   email: 'l@x.com', organisationId: ORG }

    it('refuses a visiting member with a reason, not a 404', async () => {
      mockRepo.findReachable.mockResolvedValue(visitor as never)

      await expect(service.purgeUser(ORG, 'u2')).rejects.toBeInstanceOf(ConflictError)
      await expect(service.purgeUser(ORG, 'u2')).rejects.toThrow(/another organisation/i)
      // The tenancy check must happen BEFORE anything is counted or deleted.
      expect(mockRepo.countBelongings).not.toHaveBeenCalled()
      expect(mockRepo.purge).not.toHaveBeenCalled()
    })

    it('is still a 404 for somebody this organisation cannot see at all', async () => {
      mockRepo.findReachable.mockResolvedValue(null)
      await expect(service.purgeUser(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
      expect(mockRepo.purge).not.toHaveBeenCalled()
    })

    it('refuses the account the caller is signed in as', async () => {
      mockRepo.findReachable.mockResolvedValue(local as never)
      await expect(service.purgeUser(ORG, 'u3', 'u3')).rejects.toBeInstanceOf(ConflictError)
      expect(mockRepo.purge).not.toHaveBeenCalled()
    })

    it('refuses an account carrying operations history', async () => {
      mockRepo.findReachable.mockResolvedValue(local as never)
      mockRepo.countBelongings.mockResolvedValue({
        organisationIds: [ORG], roles: 0, sessions: 0, invites: 0, assignments: 0,
        trips: 4, thefts: 0, violations: 0, speeding: 0, pushes: 0, operational: 4,
      } as never)

      await expect(service.purgeUser(ORG, 'u3')).rejects.toThrow(/operations history/i)
      expect(mockRepo.purge).not.toHaveBeenCalled()
    })

    it('destroys a local account with nothing held against it', async () => {
      mockRepo.findReachable.mockResolvedValue(local as never)
      mockRepo.countBelongings.mockResolvedValue({
        organisationIds: [ORG], roles: 2, sessions: 1, invites: 0, assignments: 0,
        trips: 0, thefts: 0, violations: 0, speeding: 0, pushes: 0, operational: 0,
      } as never)
      mockRepo.purge.mockResolvedValue(local as never)

      const out = await service.purgeUser(ORG, 'u3')
      expect(mockRepo.purge).toHaveBeenCalledWith(ORG, 'u3', false)
      expect(out.id).toBe('u3')
    })
  })

  describe('createUser', () => {
    it('creates user in the correct org', async () => {
      const dto = { fullName: 'Alice', email: 'alice@x.com' }
      const user = makeUser(dto)
      mockRepo.create.mockResolvedValue(user as never)

      const result = await service.createUser(ORG, dto)
      expect(mockRepo.create).toHaveBeenCalledWith(ORG, dto)
      expect(result).toEqual(user)
    })
  })

  describe('updateUser', () => {
    it('updates when user exists', async () => {
      const user = makeUser({ id: 'u1' })
      mockRepo.findById.mockResolvedValue(user as never)
      mockRepo.update.mockResolvedValue({ ...user, fullName: 'Bob' } as never)

      const result = await service.updateUser(ORG, 'u1', { fullName: 'Bob' })
      expect(result.fullName).toBe('Bob')
    })

    it('throws when user not found before update', async () => {
      mockRepo.findById.mockResolvedValue(null)
      await expect(service.updateUser(ORG, 'ghost', { fullName: 'X' })).rejects.toBeInstanceOf(NotFoundError)
      expect(mockRepo.update).not.toHaveBeenCalled()
    })
  })

  describe('deleteUser', () => {
    it('soft-deletes existing user', async () => {
      const user = makeUser({ id: 'u1' })
      mockRepo.findById.mockResolvedValue(user as never)
      mockRepo.softDelete.mockResolvedValue(user)

      await service.deleteUser(ORG, 'u1')
      expect(mockRepo.softDelete).toHaveBeenCalledWith(ORG, 'u1', false)
    })
  })

  describe('assignRoleToUser', () => {
    it('assigns role when no conflict', async () => {
      const user = makeUser({ id: 'u1' })
      const assignment = { id: 'ur1', assignedAt: new Date(), role: { id: 'r1', name: 'Driver', slug: 'driver' } }
      mockRepo.findById.mockResolvedValue(user as never)
      mockRepo.assignRole.mockResolvedValue(assignment)

      const result = await service.assignRoleToUser(ORG, 'u1', { roleId: 'r1' })
      expect(result).toEqual(assignment)
    })

    it('throws ConflictError on duplicate assignment (P2002)', async () => {
      const user = makeUser({ id: 'u1' })
      mockRepo.findById.mockResolvedValue(user as never)
      mockRepo.assignRole.mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }))

      await expect(service.assignRoleToUser(ORG, 'u1', { roleId: 'r1' })).rejects.toBeInstanceOf(ConflictError)
    })
  })

  describe('revokeRoleFromUser', () => {
    it('revokes active role assignment', async () => {
      const user = makeUser({ id: 'u1' })
      mockRepo.findById.mockResolvedValue(user as never)
      mockRepo.revokeRole.mockResolvedValue({ id: 'ur1', revokedAt: new Date() } as never)

      const result = await service.revokeRoleFromUser(ORG, 'u1', 'r1')
      expect(result).toBeDefined()
    })

    it('throws NotFoundError when no active assignment', async () => {
      const user = makeUser({ id: 'u1' })
      mockRepo.findById.mockResolvedValue(user as never)
      mockRepo.revokeRole.mockResolvedValue(null)

      await expect(service.revokeRoleFromUser(ORG, 'u1', 'r1')).rejects.toBeInstanceOf(NotFoundError)
    })
  })
})
