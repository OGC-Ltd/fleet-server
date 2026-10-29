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

  it('takes 0.2 off the rating for every harsh acceleration and hard braking report', () => {
    const base = { baseScore: 5, trips: 20, mileageKm: 1200, tonnes: 45, daysSinceLastTrip: 1 }
    const clean = calculateDriverRating(base)
    const harsh = calculateDriverRating({ ...base, harshAccelerationCases: 3, harshBrakingCases: 2 })
    expect(harsh.score).toBe(clean.score)
    expect(harsh.rating).toBe(clean.rating - 1)
  })

  it('rates a driver posted to a unit with no trips, from 5 down by their cases', () => {
    const posted = { baseScore: 5, trips: 0, mileageKm: 0, daysSinceLastTrip: 999, postedToUnit: true }
    expect(calculateDriverRating({ ...posted, postedToUnit: false }).band).toBe('Inactive')
    expect(calculateDriverRating(posted).rating).toBe(5)
    expect(calculateDriverRating({ ...posted, harshAccelerationCases: 1 }).rating).toBe(4.8)
    expect(calculateDriverRating({ ...posted, fuelTheftCases: 2 }).rating).toBeLessThan(5)
  })

  it('never takes the rating below 0', () => {
    const base = { baseScore: 5, trips: 20, mileageKm: 1200, tonnes: 45, daysSinceLastTrip: 1 }
    const r = calculateDriverRating({ ...base, harshAccelerationCases: 400, harshBrakingCases: 300 })
    expect(r.rating).toBe(0)
    expect(r.band).toBe('Poor')
  })

  it('takes six points off for every fuel theft case', () => {
    const base = { baseScore: 5, trips: 20, mileageKm: 1200, tonnes: 45, daysSinceLastTrip: 1 }
    expect(calculateDriverRating(base).score - calculateDriverRating({ ...base, fuelTheftCases: 2 }).score).toBe(12)
  })

  it('takes three points off for every overspeeding case', () => {
    const base = { baseScore: 5, trips: 20, mileageKm: 1200, tonnes: 45, daysSinceLastTrip: 1 }
    expect(calculateDriverRating(base).score - calculateDriverRating({ ...base, overspeedingCases: 2 }).score).toBe(6)
  })
})
