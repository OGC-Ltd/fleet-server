import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError, ConflictError } from '../../src/core/errors/errors.js'

vi.mock('../../src/modules/users/user.repository.ts')

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
      expect(mockRepo.softDelete).toHaveBeenCalledWith(ORG, 'u1')
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
