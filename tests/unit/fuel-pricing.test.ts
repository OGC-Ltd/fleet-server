/**
 * The fuel ledger stores litres; every money figure the dashboard shows is
 * derived here. These tests pin the two things an operator would actually
 * catch: that the per-vehicle costs add up to the total, and that a quiet
 * window doesn't inflate the daily average.
 */

import { describe, it, expect } from 'vitest'
import { priceFuelConsumption } from '../../src/modules/analytics/fuel-pricing.js'

type Consumption = Parameters<typeof priceFuelConsumption>[0]

const PRICE = { pricePerLitre: 179.36, currency: 'KES', source: 'configured' as const }

/** A window with `filled`/`stolen` millilitres on one day, and two vehicles. */
function consumption(overrides: Partial<Consumption> = {}): Consumption {
  return {
    totals: { filledMl: 0, stolenMl: 0, fillings: 0, thefts: 0, windowDays: 30, activeDays: 0 },
    byDay: [],
    byVehicle: [],
    ...overrides,
  } as Consumption
}

describe('priceFuelConsumption', () => {
  it('costs millilitres at the given rate', () => {
    const out = priceFuelConsumption(consumption({
      totals: { filledMl: 42_130, stolenMl: 13_090, fillings: 1, thefts: 1, windowDays: 30, activeDays: 1 },
    }), PRICE)

    expect(out.totals.litresFilled).toBe(42.1)
    expect(out.totals.litresLost).toBe(13.1)
    // 42.13 L × 179.36 = 7 556.44
    expect(out.totals.cost).toBe(7556)
    expect(out.totals.lossCost).toBe(2348)
  })

  it('echoes the rate and where it came from', () => {
    const out = priceFuelConsumption(consumption(), { ...PRICE, pricePerLitre: 200, source: 'request' })
    expect(out.price).toEqual({ pricePerLitre: 200, currency: 'KES', source: 'request' })
  })

  it('keeps per-vehicle costs summing to the total', () => {
    // Three awkward volumes: rounding each to 0.1 L before pricing would drift.
    const out = priceFuelConsumption(consumption({
      totals: { filledMl: 33_333 * 3, stolenMl: 0, fillings: 3, thefts: 0, windowDays: 7, activeDays: 3 },
      byVehicle: [
        { vehicleId: 'v1', registrationPlate: 'KDL 201X', name: null, filledMl: 33_333, stolenMl: 0, fillings: 1, thefts: 0 },
        { vehicleId: 'v2', registrationPlate: 'KDL 208X', name: null, filledMl: 33_333, stolenMl: 0, fillings: 1, thefts: 0 },
        { vehicleId: 'v3', registrationPlate: 'KDL 708E', name: null, filledMl: 33_333, stolenMl: 0, fillings: 1, thefts: 0 },
      ],
    }), PRICE)

    const summed = out.byVehicle.reduce((n, v) => n + v.cost, 0)
    // Whole-unit rounding per row allows at most half a unit of drift each way.
    expect(Math.abs(summed - out.totals.cost)).toBeLessThanOrEqual(out.byVehicle.length)
  })

  it('averages over active days, not window days', () => {
    const out = priceFuelConsumption(consumption({
      // 400 L across 4 fuelling days inside a 30-day window.
      totals: { filledMl: 400_000, stolenMl: 0, fillings: 4, thefts: 0, windowDays: 30, activeDays: 4 },
    }), PRICE)

    expect(out.averages.perDayLitres).toBe(100)
  })

  it('does not divide by zero on a window with no fuel movement', () => {
    const out = priceFuelConsumption(consumption(), PRICE)

    expect(out.totals.cost).toBe(0)
    expect(out.averages.perDayLitres).toBe(0)
    expect(out.averages.perDayCost).toBe(0)
  })

  it('prices each day of the zero-filled series', () => {
    const out = priceFuelConsumption(consumption({
      totals: { filledMl: 50_000, stolenMl: 0, fillings: 1, thefts: 0, windowDays: 2, activeDays: 1 },
      byDay: [
        { day: '2026-08-02', filledMl: 0,      stolenMl: 0,      fillings: 0, thefts: 0 },
        { day: '2026-08-03', filledMl: 50_000, stolenMl: 10_000, fillings: 1, thefts: 1 },
      ],
    }), PRICE)

    expect(out.byDay[0]).toMatchObject({ day: '2026-08-02', litresFilled: 0, cost: 0 })
    expect(out.byDay[1]).toMatchObject({ day: '2026-08-03', litresFilled: 50, litresLost: 10 })
    expect(out.byDay[1]?.cost).toBe(8968)
  })
})
