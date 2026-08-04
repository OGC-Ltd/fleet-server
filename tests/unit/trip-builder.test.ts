import { describe, it, expect } from 'vitest'
import { measureKm, movingAvgSpeedKmh } from '../../src/lib/trip-builder.js'

const fix = (lat: number, lng: number, s: number | null = 0) => ({
  capturedAt: new Date(), lat, lng, speedKmh: s,
})

// ~111 m per 0.001° of latitude at the equator; Ndhiwa is close enough to it
// that the arithmetic below is easy to reason about.
const NORTH = (n: number) => fix(-0.8223 + n * 0.001, 34.3850)

describe('measureKm', () => {
  it('sums the legs actually driven', () => {
    // Four fixes, three legs of ~111 m each.
    const km = measureKm([NORTH(0), NORTH(1), NORTH(2), NORTH(3)])
    expect(km).toBeGreaterThan(0.32)
    expect(km).toBeLessThan(0.34)
  })

  it('is zero for a single fix', () => {
    expect(measureKm([NORTH(0)])).toBe(0)
  })

  it('ignores the wander of a parked vehicle', () => {
    // Fixes a few metres apart in both directions — satellite geometry, not
    // movement. Summed naively over a nineteen-hour round trip this is the
    // difference between a real distance and an invented one.
    const jitter = Array.from({ length: 200 }, (_, i) =>
      fix(-0.8223 + (i % 2) * 0.00005, 34.3850 + (i % 3) * 0.00004))
    expect(measureKm(jitter)).toBe(0)
  })

  it('does not count a coverage gap as distance driven', () => {
    // A truck disappears into a dead zone and reappears 40 km away. The
    // straight line between the two is not road it drove.
    const km = measureKm([NORTH(0), NORTH(1), fix(-0.4600, 34.3850), NORTH(2)])
    // Only the first 111 m leg survives; both legs across the gap are dropped.
    expect(km).toBeLessThan(0.15)
  })

  it('keeps a normal highway leg between two-minute fixes', () => {
    // 80 km/h for two minutes is ~2.7 km — well inside the ceiling, and exactly
    // the kind of leg a too-tight limit would silently discard.
    const km = measureKm([fix(-0.8223, 34.3850), fix(-0.7983, 34.3850)])
    expect(km).toBeGreaterThan(2.5)
    expect(km).toBeLessThan(2.8)
  })
})

// The interrupted-delivery KPI (analytics.repository) divides distance by this
// average to get an expected transit time and flags the trip when the actual
// duration exceeds twice it. What that test can detect is decided entirely
// here, so these cases are about the KPI as much as the arithmetic.
describe('movingAvgSpeedKmh', () => {
  it('averages only the samples that were moving', () => {
    // Nine hours parked, then three fixes on the road. Including the zeroes
    // would drag the average down towards the elapsed-time figure.
    const fixes = [
      ...Array.from({ length: 9 }, () => fix(-0.8223, 34.3850, 0)),
      fix(-0.8223, 34.3850, 60), fix(-0.8223, 34.3850, 70), fix(-0.8223, 34.3850, 80),
    ]
    expect(movingAvgSpeedKmh(fixes)).toBe(70)
  })

  it('leaves a stalled run detectable rather than tautologically timely', () => {
    // 210 km covered, 3 h of it moving at 70 km/h and 16 h stopped. The old
    // definition returned distance ÷ elapsed (210 / 19 ≈ 11.1), which makes
    // expected transit = 210 / 11.1 = the elapsed time itself — a trip can then
    // never exceed 2× its own duration and every trip reports timely.
    const mileageKm = 210
    const durationHours = 19
    const avg = movingAvgSpeedKmh([
      ...Array.from({ length: 16 }, () => fix(-0.8223, 34.3850, 0)),
      ...Array.from({ length: 3 }, () => fix(-0.8223, 34.3850, 70)),
    ])!
    const expectedHours = mileageKm / avg
    expect(avg).toBe(70)
    expect(durationHours).toBeGreaterThan(expectedHours * 2) // flagged interrupted
  })

  it('is null when nothing moved, never zero', () => {
    // Zero would divide into an infinite expected transit time and flag a trip
    // that simply never reported a moving fix.
    expect(movingAvgSpeedKmh([fix(-0.8223, 34.3850, 0), fix(-0.8223, 34.3850, 0)])).toBeNull()
    expect(movingAvgSpeedKmh([fix(-0.8223, 34.3850, null), fix(-0.8223, 34.3850, null)])).toBeNull()
  })

  it('ignores sub-threshold jitter the way movement-state does', () => {
    // 0.5 km/h is a stationary unit's noise, not a leg. The two modules answer
    // the same question and must not disagree about what "moving" means.
    expect(movingAvgSpeedKmh([fix(-0.8223, 34.3850, 0.5), fix(-0.8223, 34.3850, 40)])).toBe(40)
  })
})
