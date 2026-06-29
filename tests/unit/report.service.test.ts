import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError } from '../../src/core/errors/errors.js'

vi.mock('../../src/modules/reports/report.repository.ts')
// refreshSummaries calls prisma directly — mock it too
vi.mock('../../src/lib/prisma.ts', () => ({
  prisma: {
    trip: { groupBy: vi.fn().mockResolvedValue([]) },
    fuelFilling: { groupBy: vi.fn().mockResolvedValue([]) },
    fuelTheft: { groupBy: vi.fn().mockResolvedValue([]) },
  },
}))

import * as repo from '../../src/modules/reports/report.repository.js'
import * as service from '../../src/modules/reports/report.service.js'
import { makePeriod, TEST_ORG_ID } from '../helpers/factories.js'

const mockRepo = vi.mocked(repo)
const ORG = TEST_ORG_ID

beforeEach(() => vi.clearAllMocks())

describe('report.service', () => {
  describe('getPeriod', () => {
    it('returns period when found', async () => {
      const period = makePeriod({ id: 'p1' })
      mockRepo.findPeriodById.mockResolvedValue(period)

      const result = await service.getPeriod(ORG, 'p1')
      expect(result).toEqual(period)
    })

    it('throws NotFoundError when period missing', async () => {
      mockRepo.findPeriodById.mockResolvedValue(null)
      await expect(service.getPeriod(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('createPeriod', () => {
    it('creates period in correct org', async () => {
      const dto = {
        label: 'Week 1',
        periodStart: new Date('2026-06-01'),
        periodEnd: new Date('2026-06-07'),
        periodType: 'WEEKLY' as const,
      }
      const period = makePeriod(dto)
      mockRepo.createPeriod.mockResolvedValue(period)

      const result = await service.createPeriod(ORG, dto)
      expect(mockRepo.createPeriod).toHaveBeenCalledWith(ORG, dto)
      expect(result).toEqual(period)
    })
  })

  describe('listSummaries', () => {
    it('delegates to repo', async () => {
      mockRepo.findSummaries.mockResolvedValue({ data: [], total: 0 })

      const result = await service.listSummaries(ORG, { page: 1, limit: 20 })
      expect(result.total).toBe(0)
      expect(mockRepo.findSummaries).toHaveBeenCalledWith(ORG, { page: 1, limit: 20 })
    })
  })

  describe('refreshSummaries', () => {
    it('throws NotFoundError when period does not exist', async () => {
      mockRepo.findPeriodById.mockResolvedValue(null)
      await expect(service.refreshSummaries(ORG, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('runs aggregation and returns count', async () => {
      const period = makePeriod({ id: 'p1' })
      mockRepo.findPeriodById.mockResolvedValue(period)
      mockRepo.upsertSummary.mockResolvedValue({} as never)

      const result = await service.refreshSummaries(ORG, 'p1')
      expect(result).toEqual({ refreshed: 0 }) // no trips → 0 vehicle aggregates
    })
  })
})
