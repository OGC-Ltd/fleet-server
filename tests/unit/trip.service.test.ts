import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError } from '../../src/core/errors/errors.js'

vi.mock('../../src/modules/trips/trip.repository.ts')

import * as repo from '../../src/modules/trips/trip.repository.js'
import * as service from '../../src/modules/trips/trip.service.js'
import { makeTrip, TEST_ORG_ID } from '../helpers/factories.js'

const mockRepo = vi.mocked(repo)
const ORG = TEST_ORG_ID

beforeEach(() => vi.clearAllMocks())

describe('trip.service', () => {
  describe('listTrips', () => {
    it('returns cursor-paginated result', async () => {
      const trips = [makeTrip(), makeTrip()]
      mockRepo.findAll.mockResolvedValue({ data: trips as never, cursor: 'cuid_next', hasNextPage: true })

      const result = await service.listTrips(ORG, { limit: 2 })

      expect(result.data).toHaveLength(2)
      expect(result.hasNextPage).toBe(true)
      expect(result.cursor).toBe('cuid_next')
      expect(mockRepo.findAll).toHaveBeenCalledWith(ORG, { limit: 2 })
    })

    it('returns empty result when no trips', async () => {
      mockRepo.findAll.mockResolvedValue({ data: [], cursor: null, hasNextPage: false })

      const result = await service.listTrips(ORG, { limit: 50 })
      expect(result.data).toHaveLength(0)
      expect(result.hasNextPage).toBe(false)
    })
  })

  describe('getTrip', () => {
    it('returns trip when found', async () => {
      const trip = makeTrip({ id: 't1' })
      mockRepo.findById.mockResolvedValue(trip as never)

      const result = await service.getTrip(ORG, 't1')
      expect(result).toEqual(trip)
    })

    it('throws NotFoundError when trip missing', async () => {
      mockRepo.findById.mockResolvedValue(null)
      await expect(service.getTrip(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('createTrip', () => {
    it('creates and returns the trip', async () => {
      const dto = {
        vehicleId: 'v1',
        reportingPeriodId: 'p1',
        beganAt: new Date(),
        endedAt: new Date(),
        durationSeconds: 3600,
        mileageKm: 120,
      }
      const trip = makeTrip(dto)
      mockRepo.create.mockResolvedValue(trip)

      const result = await service.createTrip(dto)
      expect(mockRepo.create).toHaveBeenCalledWith(dto)
      expect(result).toEqual(trip)
    })
  })
})
