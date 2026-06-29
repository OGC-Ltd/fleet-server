import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError } from '../../src/core/errors/errors.js'

// Mock repository before importing service
vi.mock('../../src/modules/organisations/organisation.repository.ts')

import * as repo from '../../src/modules/organisations/organisation.repository.js'
import * as service from '../../src/modules/organisations/organisation.service.js'
import { makeOrg } from '../helpers/factories.js'

const mockRepo = vi.mocked(repo)

beforeEach(() => vi.clearAllMocks())

describe('organisation.service', () => {
  describe('getOrganisation', () => {
    it('returns the org when found', async () => {
      const org = makeOrg({ id: 'org_1' })
      mockRepo.findById.mockResolvedValue(org)

      const result = await service.getOrganisation('org_1')

      expect(result).toEqual(org)
      expect(mockRepo.findById).toHaveBeenCalledWith('org_1')
    })

    it('throws NotFoundError when org does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null)

      await expect(service.getOrganisation('missing')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('listOrganisations', () => {
    it('delegates to repo with correct pagination', async () => {
      const orgs = [makeOrg(), makeOrg()]
      mockRepo.findAll.mockResolvedValue({ data: orgs, total: 2 })

      const result = await service.listOrganisations({ page: 1, limit: 20 })

      expect(result.data).toHaveLength(2)
      expect(result.total).toBe(2)
      expect(mockRepo.findAll).toHaveBeenCalledWith({ page: 1, limit: 20 })
    })
  })

  describe('createOrganisation', () => {
    it('creates and returns the new org', async () => {
      const dto = { name: 'New Org', code: 'NEW' }
      const org = makeOrg(dto)
      mockRepo.create.mockResolvedValue(org)

      const result = await service.createOrganisation(dto)

      expect(result).toEqual(org)
      expect(mockRepo.create).toHaveBeenCalledWith(dto)
    })
  })

  describe('updateOrganisation', () => {
    it('verifies existence then updates', async () => {
      const org = makeOrg({ id: 'org_1' })
      mockRepo.findById.mockResolvedValue(org)
      mockRepo.update.mockResolvedValue({ ...org, name: 'Updated' })

      const result = await service.updateOrganisation('org_1', { name: 'Updated' })

      expect(result.name).toBe('Updated')
      expect(mockRepo.findById).toHaveBeenCalledWith('org_1')
      expect(mockRepo.update).toHaveBeenCalledWith('org_1', { name: 'Updated' })
    })

    it('throws NotFoundError when org does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null)

      await expect(service.updateOrganisation('ghost', { name: 'X' })).rejects.toBeInstanceOf(NotFoundError)
      expect(mockRepo.update).not.toHaveBeenCalled()
    })
  })
})
