import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError, ConflictError } from '../../src/core/errors/errors.js'

vi.mock('../../src/modules/vehicles/vehicle.repository.ts')

import * as repo from '../../src/modules/vehicles/vehicle.repository.js'
import * as service from '../../src/modules/vehicles/vehicle.service.js'
import { makeVehicle, makeVehicleGroup, TEST_ORG_ID } from '../helpers/factories.js'

const mockRepo = vi.mocked(repo)
const ORG = TEST_ORG_ID

beforeEach(() => vi.clearAllMocks())

describe('vehicle.service', () => {
  describe('getVehicle', () => {
    it('returns vehicle when found', async () => {
      const v = makeVehicle({ id: 'v1' })
      mockRepo.findVehicleById.mockResolvedValue(v as never)

      const result = await service.getVehicle(ORG, 'v1')
      expect(result).toEqual(v)
    })

    it('throws NotFoundError when vehicle missing', async () => {
      mockRepo.findVehicleById.mockResolvedValue(null)
      await expect(service.getVehicle(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('createAssignment', () => {
    it('creates PRIMARY assignment when none active', async () => {
      const v = makeVehicle({ id: 'v1' })
      mockRepo.findVehicleById.mockResolvedValue(v as never)
      mockRepo.findAssignments.mockResolvedValue([])
      mockRepo.createAssignment.mockResolvedValue({ id: 'a1' } as never)

      const result = await service.createAssignment(ORG, 'v1', {
        userId: 'u1',
        assignmentType: 'PRIMARY',
      })

      expect(result).toBeDefined()
      expect(mockRepo.createAssignment).toHaveBeenCalled()
    })

    it('throws ConflictError when PRIMARY already active', async () => {
      const v = makeVehicle({ id: 'v1' })
      const activeAssignment = { id: 'a0', assignmentType: 'PRIMARY', unassignedAt: null } as never
      mockRepo.findVehicleById.mockResolvedValue(v as never)
      mockRepo.findAssignments.mockResolvedValue([activeAssignment])

      await expect(
        service.createAssignment(ORG, 'v1', { userId: 'u2', assignmentType: 'PRIMARY' })
      ).rejects.toBeInstanceOf(ConflictError)

      expect(mockRepo.createAssignment).not.toHaveBeenCalled()
    })

    it('allows RELIEF assignment when PRIMARY exists', async () => {
      const v = makeVehicle({ id: 'v1' })
      const primaryAssignment = { id: 'a0', assignmentType: 'PRIMARY', unassignedAt: null } as never
      mockRepo.findVehicleById.mockResolvedValue(v as never)
      mockRepo.findAssignments.mockResolvedValue([primaryAssignment])
      mockRepo.createAssignment.mockResolvedValue({ id: 'a1' } as never)

      const result = await service.createAssignment(ORG, 'v1', {
        userId: 'u2',
        assignmentType: 'RELIEF',
      })

      expect(result).toBeDefined()
    })
  })

  describe('deleteVehicle', () => {
    it('deletes when vehicle exists', async () => {
      const v = makeVehicle({ id: 'v1' })
      mockRepo.findVehicleById.mockResolvedValue(v as never)
      mockRepo.deleteVehicle.mockResolvedValue(v)

      await service.deleteVehicle(ORG, 'v1')
      expect(mockRepo.deleteVehicle).toHaveBeenCalledWith(ORG, 'v1')
    })
  })

  describe('getGroup', () => {
    it('throws NotFoundError when group missing', async () => {
      mockRepo.findGroupById.mockResolvedValue(null)
      await expect(service.getGroup(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('returns group when found', async () => {
      const g = makeVehicleGroup({ id: 'g1' })
      mockRepo.findGroupById.mockResolvedValue(g)
      const result = await service.getGroup(ORG, 'g1')
      expect(result).toEqual(g)
    })
  })
})
