/** The fuel figures Vehicle analytics gives, as the server works them out for TAT and Fuel. */
import { describe, it, expect } from 'vitest'
import { asDaySeries, fuelBalance, ruledOut, stopLitres, tripDistanceKm, type BalanceDrain, type BalanceFilling, type BalanceReading } from '../../src/modules/fuel/fuel-balance.js'

const MIN = 60_000
const at = (m: number, fuelL: number | null, speedKmh = 0, lat = 0.5, lng = 34.5): BalanceReading => ({ t: m * MIN, lat, lng, speedKmh, fuelMl: fuelL == null ? null : fuelL * 1000 })
const fill = (m: number, o: Partial<BalanceFilling> = {}): BalanceFilling => ({ at: m * MIN, verdict: 'REFILL', observedRiseMl: 50_000, filledMl: 60_000, initialFuelLevelMl: null, finalFuelLevelMl: null, ...o })
const drain = (m: number, o: Partial<BalanceDrain> = {}): BalanceDrain => ({
  at: m * MIN, verdict: 'DRAIN', drainCause: 'SIPHON', cleanDropMl: 10_000, measuredDropMl: 12_000, stolenMl: 14_000, finalFuelLevelMl: 80_000, reviewStatus: null, dismissedAt: null, ...o,
})
const span = { from: 0, to: 100 * MIN }
const flat = (fuelL: number, a: number, n = 7) => Array.from({ length: n }, (_, i) => at(a + i, fuelL))

describe('fuelBalance', () => {
  it('balances the tank: initial + filled - theft - final', () => {
    const b = fuelBalance({ readings: [...flat(100, 0), ...flat(120, 50)], fillings: [fill(20)], drains: [drain(30)], ...span })
    expect(b).toMatchObject({ startL: 100, endL: 120, filledL: 50, theftL: 10, consumedL: 20, unrecordedL: 0 })
  })
  it('matches the captured Fuel Report period balance', () => {
    const b = fuelBalance({
      readings: [...flat(98.5, 0), ...flat(126.8, 50)],
      fillings: [fill(25, { observedRiseMl: 45_900 })],
      drains: [],
      ...span,
    })
    expect(b).toMatchObject({ startL: 98.5, endL: 126.8, filledL: 45.9, consumedL: 17.6 })
  })
  it('takes the middle of the first and last 7, past a dead probe', () => {
    const b = fuelBalance({ readings: [at(0, 0.1), at(1, 100), at(2, 500), at(3, 101), at(4, 99), at(5, 100), at(6, 100), at(7, 100)], fillings: [], drains: [], ...span })
    expect(b.startL).toBe(100)
  })
  it('counts a filling by the rise it observed, else what it recorded, and only if judged a filling', () => {
    const fillings = [fill(0), fill(70, { observedRiseMl: null }), fill(140, { verdict: null }), fill(210, { verdict: 'PENDING' }), fill(280, { verdict: 'SLOSH' })]
    expect(fuelBalance({ readings: flat(100, 0), fillings, drains: [], from: 0, to: 400 * MIN }).filledL).toBe(50 + 60 + 50 + 50)
  })
  it('counts only siphon drains, by their clean drop, and never a probe going dark', () => {
    const drains = [
      drain(1), drain(2, { cleanDropMl: null }), drain(3, { cleanDropMl: null, measuredDropMl: null }),
      drain(4, { drainCause: 'CONSUMPTION' }), drain(5, { verdict: 'PENDING' }), drain(6, { finalFuelLevelMl: 100 }),
    ]
    expect(fuelBalance({ readings: flat(100, 0), fillings: [], drains, ...span }).theftL).toBe(10 + 12 + 14)
  })
  it('reads a rise nothing recorded as unrecorded, not as negative consumption', () => {
    const b = fuelBalance({ readings: [...flat(100, 0), ...flat(150, 50)], fillings: [], drains: [], ...span })
    expect(b).toMatchObject({ consumedL: 0, unrecordedL: 50, kmPerL: null })
  })
  it('keeps to the period: from included, to left out', () => {
    const b = fuelBalance({
      readings: [...flat(100, 0), ...flat(200, 100)], fillings: [fill(0), fill(100)], drains: [drain(0), drain(100)], from: 0, to: 100 * MIN,
    })
    expect(b).toMatchObject({ endL: 100, filledL: 50, theftL: 10 })
  })
  it('still gives the ledger when no reading read a tank', () => {
    expect(fuelBalance({ readings: [at(0, null), at(1, 0.2)], fillings: [fill(0)], drains: [], ...span }))
      .toMatchObject({ startL: null, endL: null, filledL: 50, consumedL: null, kmPerL: null })
  })
  it('gives km to the litre over mileage in trips', () => {
    const go = Array.from({ length: 11 }, (_, i) => at(10 + i, null, 40, 0.5 + i * 0.01))
    const b = fuelBalance({ readings: [...flat(100, 0), ...go, ...flat(90, 50)], fillings: [], drains: [], ...span })
    expect(b.consumedL).toBe(10)
    expect(b.distanceKm).toBeGreaterThan(11)
    expect(b.kmPerL).toBeCloseTo(b.distanceKm / 10, 6)
  })
})

describe('tripDistanceKm', () => {
  const road = (a: number, n: number, speed = 40) => Array.from({ length: n }, (_, i) => at(a + i, null, speed, 0.5 + (a + i) * 0.001))
  it('counts moving stretches only', () => {
    const moved = tripDistanceKm(road(0, 11))
    expect(moved).toBeCloseTo(1.11, 1)
    expect(tripDistanceKm(road(0, 11, 2))).toBe(0)
  })
  it('does not carry distance over a gap in the readings', () => {
    expect(tripDistanceKm([...road(0, 6), ...road(30, 6)])).toBeCloseTo(tripDistanceKm(road(0, 6)) * 2, 3)
  })
  it('leaves out jitter under 20 m', () => {
    expect(tripDistanceKm(Array.from({ length: 10 }, (_, i) => at(i, null, 10, 0.5 + i * 0.00001)))).toBe(0)
  })
})

describe('asDaySeries', () => {
  it('rounds as the day series does', () => {
    expect(asDaySeries({ t: 1_499, lat: 0.1234567, lng: 34.1234567, speedKmh: 2.6, fuelMl: 1000.4 }))
      .toEqual({ t: 1000, lat: 0.12346, lng: 34.12346, speedKmh: 3, fuelMl: 1000 })
  })
})

describe('stopLitres', () => {
  const stop = (m: number, rise: number, before: number, after: number) => fill(m, { observedRiseMl: rise, initialFuelLevelMl: before, finalFuelLevelMl: after })
  it('does not count overlapping rises twice (KCS 644G, 2 Nov)', () => {
    const [l, ...rest] = stopLitres([stop(18, 78_297, 168_530, 236_920), stop(0, 85_820, 151_030, 163_410)])
    expect(rest).toEqual([])
    expect(l).toBeCloseTo(85.89, 2)
  })
  it('keeps the biggest rise where the levels say less', () => {
    expect(stopLitres([stop(0, 60_000, 100_000, 105_000), stop(10, 20_000, 105_000, 110_000)])).toEqual([60])
  })
  it('leaves fillings over an hour apart alone', () => {
    expect(stopLitres([stop(0, 50_000, 100_000, 150_000), stop(61, 40_000, 120_000, 160_000)])).toEqual([50, 40])
  })
  it('reads a chain as one stop', () => {
    expect(stopLitres([stop(0, 30_000, 100_000, 130_000), stop(50, 30_000, 130_000, 160_000), stop(100, 30_000, 160_000, 190_000)])).toEqual([90])
  })
})

describe('ruledOut', () => {
  const when = new Date(0)
  it('takes a reviewer at their word', () => {
    for (const reviewStatus of ['DISMISSED', 'NOT_THEFT', 'PROBE_FAULT']) expect(ruledOut({ reviewStatus, dismissedAt: null })).toBe(true)
    expect(ruledOut({ reviewStatus: null, dismissedAt: when })).toBe(true)
  })
  it('keeps a theft under review or confirmed, though it was dismissed on the way', () => {
    expect(ruledOut({ reviewStatus: 'CONFIRMED_THEFT', dismissedAt: when })).toBe(false)
    expect(ruledOut({ reviewStatus: 'UNDER_REVIEW', dismissedAt: when })).toBe(false)
    expect(ruledOut({ reviewStatus: null, dismissedAt: null })).toBe(false)
  })
})
