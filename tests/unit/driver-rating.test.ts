import { describe, expect, it } from 'vitest'
import { calculateDriverRating, dutyDaysOf } from '../../src/modules/analytics/driver-rating.js'

describe('calculateDriverRating', () => {
  const full = { trips: 40, mileageKm: 2500, tonnes: 100, dutyDays: 30 }

  it('leaves a driver with no work and no duty unrated', () => {
    expect(calculateDriverRating({})).toEqual({ score: 0, rating: 0, band: 'Inactive' })
  })

  it('earns 5 from full work and a month on duty', () => {
    const r = calculateDriverRating(full)
    expect(r.rating).toBe(5)
    expect(r.band).toBe('Excellent')
  })

  it('earns half from work and half from duty, starting at 0', () => {
    expect(calculateDriverRating({ dutyDays: 30 }).rating).toBe(2.5)
    expect(calculateDriverRating({ dutyDays: 15 }).rating).toBe(1.3)
    expect(calculateDriverRating({ trips: 40, mileageKm: 2500, tonnes: 100 }).rating).toBe(2.5)
    expect(calculateDriverRating({ trips: 20, mileageKm: 1250, tonnes: 50, dutyDays: 30 }).rating).toBe(3.8)
  })

  it('takes 0.2 off for every harsh acceleration and hard braking report', () => {
    expect(calculateDriverRating({ ...full, harshAccelerationCases: 3, harshBrakingCases: 2 }).rating).toBe(4)
  })

  it('keeps the original weights for confirmed theft and overspeeding', () => {
    expect(calculateDriverRating({ ...full, fuelTheftCases: 2 }).rating).toBe(4.4)
    expect(calculateDriverRating({ ...full, overspeedingCases: 2 }).rating).toBe(4.7)
  })

  it('never goes below 0', () => {
    const r = calculateDriverRating({ dutyDays: 30, harshAccelerationCases: 400 })
    expect(r.rating).toBe(0)
    expect(r.band).toBe('Poor')
  })
})

describe('dutyDaysOf', () => {
  const d = (s: string) => new Date(s + 'T00:00:00Z')
  it('counts overlapping postings once and open ones up to now', () => {
    expect(dutyDaysOf([
      { assignedAt: d('2026-10-01'), unassignedAt: d('2026-10-11') },
      { assignedAt: d('2026-10-05'), unassignedAt: null },
    ], d('2026-10-21'))).toBe(20)
  })
})
