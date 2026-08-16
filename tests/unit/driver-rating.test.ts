import { describe, expect, it } from 'vitest'
import { calculateDriverRating } from '../../src/modules/analytics/driver-rating.js'

describe('calculateDriverRating', () => {
  it('marks a driver inactive when they have no recent work', () => {
    const result = calculateDriverRating({
      baseScore: 4,
      trips: 0,
      mileageKm: 0,
      tonnes: 0,
      incentiveBonus: 0,
      fuelTheftCases: 0,
      overspeedingCases: 0,
      daysSinceLastTrip: 45,
    })

    expect(result).toEqual({
      score: 0,
      rating: 0,
      band: 'Inactive',
    })
  })

  it('rewards a strong, safe, productive driver with an excellent rating', () => {
    const result = calculateDriverRating({
      baseScore: 5,
      trips: 40,
      mileageKm: 2500,
      tonnes: 100,
      incentiveBonus: 10,
      fuelTheftCases: 0,
      overspeedingCases: 0,
      daysSinceLastTrip: 7,
    })

    expect(result.band).toBe('Excellent')
    expect(result.rating).toBe(5)
    expect(result.score).toBeGreaterThanOrEqual(85)
  })

  it('penalizes theft and overspeeding heavily', () => {
    const result = calculateDriverRating({
      baseScore: 3,
      trips: 20,
      mileageKm: 1200,
      tonnes: 45,
      incentiveBonus: 2,
      fuelTheftCases: 2,
      overspeedingCases: 4,
      daysSinceLastTrip: 10,
    })

    // The band this tier reports was renamed 'Weak' -> 'Needs Improvement'
    // for the operator-facing scale; the tier itself did not move. Its
    // threshold constant is still DRIVER_RATING_CONFIG.weakMin and it still
    // scores rating 3, which is why the two assertions below are untouched.
    expect(result.band).toBe('Needs Improvement')
    expect(result.rating).toBe(3)
    expect(result.score).toBeGreaterThanOrEqual(45)
    expect(result.score).toBeLessThan(55)
  })
})
