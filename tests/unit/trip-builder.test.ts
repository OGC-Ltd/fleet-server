import { describe, it, expect } from 'vitest'
import { measureKm, movingAvgSpeedKmh } from '../../src/lib/trip-builder.js'

// Every fix carries a TIME, because `measureKm` tests the implied speed of each
// leg and not only its length. Before 2026-08-27 these fixtures all shared one
// `new Date()`, which was harmless while the function ignored time and became a
// zero gap — an infinite implied speed — the moment it stopped.
const BASE = new Date('2026-08-27T06:00:00Z').getTime()
const fix = (lat: number, lng: number, s: number | null = 0, tS = 0) => ({
  capturedAt: new Date(BASE + tS * 1000), lat, lng, speedKmh: s,
})

// ~111 m per 0.001° of latitude at the equator; Ndhiwa is close enough to it
// that the arithmetic below is easy to reason about. Thirty seconds apart, so
// each 111 m leg implies ~13 km/h — ordinary yard-to-road movement.
const NORTH = (n: number) => fix(-0.8223 + n * 0.001, 34.3850, 0, n * 30)

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
      fix(-0.8223 + (i % 2) * 0.00005, 34.3850 + (i % 3) * 0.00004, 0, i * 30))
    expect(measureKm(jitter)).toBe(0)
  })

  it('does not count a coverage gap as distance driven', () => {
    // A truck disappears into a dead zone for an hour and reappears 40 km away.
    // The straight line between the two is not road it drove — and note the
    // implied speed is only 40 km/h, so the SPEED test passes it and the
    // teleport ceiling is what rejects it. That is why both tests exist.
    const km = measureKm([
      NORTH(0), NORTH(1),
      fix(-0.4600, 34.3850, 0, 3600),
      fix(-0.8203, 34.3850, 0, 7200),
    ])
    // Only the first 111 m leg survives; both legs across the gap are dropped.
    expect(km).toBeLessThan(0.15)
  })

  it('keeps a normal highway leg between two-minute fixes', () => {
    // 80 km/h for two minutes is ~2.7 km — well inside both limits, and exactly
    // the kind of leg a too-tight test would silently discard.
    const km = measureKm([fix(-0.8223, 34.3850), fix(-0.7983, 34.3850, 0, 120)])
    expect(km).toBeGreaterThan(2.5)
    expect(km).toBeLessThan(2.8)
  })

  it('drops a teleport the flat ceiling lets through', () => {
    // 2.7 km in 30 seconds is 320 km/h. It is under TELEPORT_CEILING_M, so
    // before 2026-08-27 it counted in full. No device in this fleet ever
    // REPORTS above 116 km/h, so the position is what is wrong — and measured
    // over 24 h, hops like this were 34.76% of SUKARI's summed distance.
    const km = measureKm([fix(-0.8223, 34.3850), fix(-0.7983, 34.3850, 0, 30)])
    expect(km).toBe(0)
  })

  it('drops a leg whose fixes share a timestamp', () => {
    // Implied speed is infinite. Devices buffer through coverage gaps and dump
    // a backlog, so identical or reversed stamps are not rare, and charging a
    // backlog's whole distance to one instant is the inflation being removed.
    expect(measureKm([fix(-0.8223, 34.3850), fix(-0.7983, 34.3850, 0, 0)])).toBe(0)
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
