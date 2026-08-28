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
    drains: [],
    ...overrides,
  } as Consumption
}

/** One drain row as the repository hands it over — millilitres, not litres. */
function drain(over: Partial<Consumption['drains'][number]> = {}) {
  return {
    id: 'd1', vehicleId: 'v1', registrationPlate: 'KDL 207X', name: 'Unit 01',
    beganAt: new Date('2026-08-20T22:50:00Z'),
    stolenMl: 40_000, levelBeforeMl: 280_900, levelAfterMl: 240_900,
    location: 'Yard', cause: 'SIPHON',
    causeReason: 'parked-sustained-fall', verdict: 'DRAIN', announced: true, fallSeconds: 3600,
    ...over,
  } as Consumption['drains'][number]
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

/**
 * This layer REBUILDS the payload field by field rather than spreading the
 * aggregate, so a field added to the repository reaches no client until it is
 * named here too — and nothing fails when it isn't. `drains` was added upstream
 * and dropped at this boundary: the endpoint went on returning a valid payload
 * with the key simply absent, tsc was satisfied because nothing read it, and
 * the report rendered an empty section instead of an error.
 */
describe('the drains behind the total', () => {
  it('passes each drain through, priced like every other level', () => {
    const out = priceFuelConsumption(consumption({
      totals: { filledMl: 0, stolenMl: 40_000, fillings: 0, thefts: 1, windowDays: 30, activeDays: 1 },
      drains: [drain()],
    }), PRICE)

    expect(out.drains).toHaveLength(1)
    expect(out.drains[0]).toMatchObject({
      registrationPlate: 'KDL 207X',
      litres: 40,
      cause: 'SIPHON',
      causeReason: 'parked-sustained-fall',
      fallSeconds: 3600,
    })
    // 40 L x 179.36
    expect(out.drains[0]!.cost).toBe(7174)
  })

  it('sums to the litres printed above it, within per-row rounding', () => {
    // The whole reason these come from the same query as the totals: the
    // MILLILITRES behind them are the same numbers, so the table cannot be
    // describing a different population from its own headline.
    //
    // It is not an exact equality, and asserting one would be a false
    // guarantee. Each row is rounded to 0.1 L on the way out while the total is
    // rounded once from the millilitre sum, so the two differ by whatever the
    // per-row rounding accumulates. Measured against production: KASULU's
    // 2,604 drains sum to 196,573.6 L against a 196,561.6 L header — 12 L, and
    // not random. `Math.round` breaks ties UPWARD and 242 of those rows end in
    // exactly 50 ml, which is +12.1 L on its own.
    //
    // Half a decilitre per row is the honest bound, and it is the same shape of
    // tolerance the per-vehicle cost test above uses for the same reason.
    const drains = [drain({ id: 'a', stolenMl: 40_050 }),   // ties, rounds up
                    drain({ id: 'b', stolenMl: 13_050 }),   // ties, rounds up
                    drain({ id: 'c', stolenMl: 7_550 })]    // ties, rounds up
    const out = priceFuelConsumption(consumption({
      totals: { filledMl: 0, stolenMl: 60_650, fillings: 0, thefts: 3, windowDays: 30, activeDays: 2 },
      drains,
    }), PRICE)

    const summed = out.drains.reduce((s, d) => s + d.litres, 0)
    expect(Math.abs(summed - out.totals.litresLost)).toBeLessThanOrEqual(out.drains.length * 0.05)
  })

  it('keeps an unmeasured fall null rather than calling it zero', () => {
    // Rows judged before 2026-08-28 have no measured duration. Zero would
    // claim an instantaneous drop that nothing observed.
    const out = priceFuelConsumption(consumption({
      drains: [drain({ fallSeconds: null, cause: null, causeReason: null })],
    }), PRICE)

    expect(out.drains[0]!.fallSeconds).toBeNull()
    expect(out.drains[0]!.cause).toBeNull()
  })
})

describe('the FSL level either side of a drain', () => {
  it('carries the tank level the probe read, in litres', () => {
    const out = priceFuelConsumption(consumption({
      drains: [drain({ levelBeforeMl: 280_900, levelAfterMl: 229_900, stolenMl: 51_000 })],
    }), PRICE)

    expect(out.drains[0]).toMatchObject({ levelBefore: 280.9, levelAfter: 229.9, litres: 51 })
  })

  it('the two levels account for the litres — the row checks itself', () => {
    // Measured over 30 days of production: stolenMl equals
    // initialFuelLevelMl - finalFuelLevelMl on 3,271 of 3,271 drains. The table
    // prints all three, so a reader can verify the arithmetic without leaving
    // the page — and this pins that they cannot silently drift apart.
    const out = priceFuelConsumption(consumption({
      drains: [drain({ levelBeforeMl: 89_000, levelAfterMl: 52_900, stolenMl: 36_100 })],
    }), PRICE)

    const d = out.drains[0]!
    expect(Math.round((d.levelBefore! - d.levelAfter!) * 10) / 10).toBe(d.litres)
  })

  it('a level the probe never gave stays null, not zero', () => {
    // Zero is a full-tank claim of "empty". Absent is absent.
    const out = priceFuelConsumption(consumption({
      drains: [drain({ levelBeforeMl: null, levelAfterMl: null })],
    }), PRICE)

    expect(out.drains[0]!.levelBefore).toBeNull()
    expect(out.drains[0]!.levelAfter).toBeNull()
  })
})

describe('recorded is not announced', () => {
  it('carries whether an operator was actually told', () => {
    // 90 of 3,275 over 30 days. A reader who takes the row count as an alert
    // count is out by a factor of thirty-six, so the payload has to be able to
    // say which is which.
    const out = priceFuelConsumption(consumption({
      drains: [drain({ id: 'a', announced: true }), drain({ id: 'b', announced: false })],
    }), PRICE)

    expect(out.drains.map(d => d.announced)).toEqual([true, false])
  })
})
