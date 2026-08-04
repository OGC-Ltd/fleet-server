import { describe, it, expect } from 'vitest'
import { measureKm } from '../../src/lib/trip-builder.js'

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
