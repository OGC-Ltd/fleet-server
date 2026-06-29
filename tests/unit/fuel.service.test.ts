import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError } from '../../src/core/errors/errors.js'

vi.mock('../../src/modules/fuel/fuel.repository.ts')

import * as repo from '../../src/modules/fuel/fuel.repository.js'
import * as service from '../../src/modules/fuel/fuel.service.js'
import { makeFilling, makeTheft, TEST_ORG_ID } from '../helpers/factories.js'

const mockRepo = vi.mocked(repo)
const ORG = TEST_ORG_ID

beforeEach(() => vi.clearAllMocks())

describe('fuel.service', () => {
  describe('listFillings', () => {
    it('returns cursor-paginated fillings', async () => {
      const items = [makeFilling(), makeFilling()]
      mockRepo.findAllFillings.mockResolvedValue({ data: items as never, cursor: null, hasNextPage: false })

      const result = await service.listFillings(ORG, { limit: 50 })
      expect(result.data).toHaveLength(2)
      expect(result.hasNextPage).toBe(false)
    })
  })

  describe('getFilling', () => {
    it('returns filling when found', async () => {
      const filling = makeFilling({ id: 'f1' })
      mockRepo.findFillingById.mockResolvedValue(filling as never)

      const result = await service.getFilling(ORG, 'f1')
      expect(result).toEqual(filling)
    })

    it('throws NotFoundError when not found', async () => {
      mockRepo.findFillingById.mockResolvedValue(null)
      await expect(service.getFilling(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('createFilling', () => {
    it('delegates creation to repo', async () => {
      const dto = { vehicleId: 'v1', reportingPeriodId: 'p1', filledAt: new Date(), filledMl: 40_000 }
      const filling = makeFilling(dto)
      mockRepo.createFilling.mockResolvedValue(filling)

      const result = await service.createFilling(dto)
      expect(result).toEqual(filling)
    })
  })

  describe('listThefts', () => {
    it('returns cursor-paginated thefts', async () => {
      const items = [makeTheft()]
      mockRepo.findAllThefts.mockResolvedValue({ data: items as never, cursor: null, hasNextPage: false })

      const result = await service.listThefts(ORG, { limit: 50 })
      expect(result.data).toHaveLength(1)
    })
  })

  describe('getTheft', () => {
    it('throws NotFoundError when theft missing', async () => {
      mockRepo.findTheftById.mockResolvedValue(null)
      await expect(service.getTheft(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('createTheft', () => {
    it('creates theft record', async () => {
      const dto = {
        vehicleId: 'v1',
        reportingPeriodId: 'p1',
        beganAt: new Date(),
        detectedAt: new Date(),
        stolenMl: 15_000,
      }
      const theft = makeTheft(dto)
      mockRepo.createTheft.mockResolvedValue(theft)

      const result = await service.createTheft(dto)
      expect(mockRepo.createTheft).toHaveBeenCalledWith(dto)
      expect(result).toEqual(theft)
    })
  })
})
