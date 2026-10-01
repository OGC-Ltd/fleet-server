/**
 * The day ledger's "Engine should use": the register's standard rate where a
 * unit has one (L/h for plant, km/L for road vehicles), the derived rate else.
 */

import { describe, it, expect } from 'vitest'
import { engineBurnMl, expectedRate, type ResolvedRate } from '../../src/modules/fuel/fuel-rate.js'

const derived: ResolvedRate = { lPerHour: 9.1, basis: 'vehicle', runs: 12, spread: null }

describe('expectedRate', () => {
  it('takes the register L/h over the derived rate', () => {
    const r = expectedRate({ ratedConsumption: 14, ratedConsumptionBasis: 'HOURS' }, derived)
    expect(r).toEqual({ lPerHour: 14, kmPerL: null, basis: 'register', runs: null, spread: null })
  })

  it('takes the register km/L for a road vehicle, with no hourly rate', () => {
    const r = expectedRate({ ratedConsumption: 2.6, ratedConsumptionBasis: 'DISTANCE' }, derived)
    expect(r).toMatchObject({ lPerHour: null, kmPerL: 2.6, basis: 'register' })
  })

  it('falls back to the derived rate without a register figure', () => {
    expect(expectedRate({ ratedConsumption: null, ratedConsumptionBasis: null }, derived))
      .toMatchObject({ lPerHour: 9.1, basis: 'vehicle' })
    expect(expectedRate(null, derived)).toMatchObject({ lPerHour: 9.1, basis: 'vehicle' })
    expect(expectedRate(null, null)).toBeNull()
  })
})

describe('engineBurnMl', () => {
  it('is hours × L/h for an hourly rate', () => {
    // CTR 19, 1 Oct: 4 h 42 min at the register's 45 L/h.
    expect(engineBurnMl(4.7 * 3600, { lPerHour: 45, kmPerL: null, basis: 'register', runs: null, spread: null }))
      .toBe(211_500)
  })

  it('is distance ÷ km/L for a road rate, ignoring engine hours', () => {
    expect(engineBurnMl(5 * 3600, { lPerHour: null, kmPerL: 2.5, basis: 'register', runs: null, spread: null }, 38_000))
      .toBe(15_200)
  })

  it('is null for a road rate without a distance', () => {
    expect(engineBurnMl(3600, { lPerHour: null, kmPerL: 2.5, basis: 'register', runs: null, spread: null }, null)).toBeNull()
  })

  it('still takes a plain derived rate', () => {
    expect(engineBurnMl(3600, derived)).toBe(9100)
  })
})
