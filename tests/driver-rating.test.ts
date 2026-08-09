import { describe, it, expect } from 'vitest'
import { calculateDriverRating } from '../src/modules/analytics/driver-rating.js'

describe('calculateDriverRating', () => {
  it('returns a strong rating for a safe, active driver', () => {
    const result = calculateDriverRating({
      baseScore: 5,
      trips: 20,
      mileageKm: 2500,
      fuelTheftCases: 0,
      overspeedingCases: 0,
      windowDays: 30,
    })

    expect(result.band).toBe('Excellent')
    expect(result.rating).toBeGreaterThanOrEqual(5)
  })

  it('penalizes repeated safety breaches', () => {
    const result = calculateDriverRating({
      baseScore: 4,
      trips: 10,
      mileageKm: 400,
      fuelTheftCases: 2,
      overspeedingCases: 4,
      windowDays: 30,
    })

    expect(result.band).toBe('Needs Improvement')
    expect(result.rating).toBeLessThan(4)
  })
})
