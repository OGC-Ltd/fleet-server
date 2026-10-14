/**
 * Route ahead + reach: the pure parts — decoding Google's answers, and the rule
 * that decides when a cached (billed) route may stand in for a new one.
 */

import { describe, it, expect } from 'vitest'
import { decodePolyline, parseDuration, areaGeometry } from '../../src/providers/google-routing/index.js'
import { routeReusable, ROUTE_MIN_AGE_MS, ROUTE_MAX_AGE_MS } from '../../src/modules/route-ahead/route-ahead.service.js'

describe('decodePolyline', () => {
  it("decodes Google's reference example", () => {
    // developers.google.com/maps/documentation/utilities/polylinealgorithm
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [38.5, -120.2], [40.7, -120.95], [43.252, -126.453],
    ])
  })
  it('returns nothing for an empty string', () => {
    expect(decodePolyline('')).toEqual([])
  })
})

describe('parseDuration', () => {
  it('reads protobuf durations', () => {
    expect(parseDuration('1234s')).toBe(1234)
    expect(parseDuration('12.5s')).toBe(12.5)
    expect(parseDuration(undefined)).toBe(0)
  })
})

describe('areaGeometry', () => {
  const ring = [[[34, -0.8], [34.1, -0.8], [34.1, -0.9], [34, -0.8]]]
  it('accepts a bare polygon, a Feature and a FeatureCollection', () => {
    expect(areaGeometry({ type: 'Polygon', coordinates: ring })).toEqual({ type: 'Polygon', coordinates: ring })
    expect(areaGeometry({ type: 'Feature', geometry: { type: 'Polygon', coordinates: ring } })?.type).toBe('Polygon')
    const fc = areaGeometry({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: ring } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: ring } },
    ] })
    expect(fc?.type).toBe('MultiPolygon')
    expect((fc?.coordinates as unknown[]).length).toBe(2)
  })
  it('refuses anything that is not an area', () => {
    expect(areaGeometry({ type: 'Point', coordinates: [34, -0.8] })).toBeNull()
    expect(areaGeometry(null)).toBeNull()
  })
})

describe('routeReusable', () => {
  const A = { lat: -0.8218, lng: 34.3820 }
  const near = { lat: -0.8226, lng: 34.3820 }   // ~90 m
  const far  = { lat: -0.8318, lng: 34.3820 }   // ~1.1 km
  const t0 = 1_000_000
  const entry = { destKey: 'D', origin: A, at: t0, route: null }

  it('never reuses for another destination', () => {
    expect(routeReusable(entry, 'E', A, t0 + 1)).toBe(false)
  })
  it('always reuses inside the minimum age, however far it moved', () => {
    expect(routeReusable(entry, 'D', far, t0 + ROUTE_MIN_AGE_MS - 1)).toBe(true)
  })
  it('reuses while the unit has barely moved', () => {
    expect(routeReusable(entry, 'D', near, t0 + ROUTE_MIN_AGE_MS + 1)).toBe(true)
  })
  it('re-routes once the unit has moved on', () => {
    expect(routeReusable(entry, 'D', far, t0 + ROUTE_MIN_AGE_MS + 1)).toBe(false)
  })
  it('re-routes a parked unit once the traffic figure is old', () => {
    expect(routeReusable(entry, 'D', A, t0 + ROUTE_MAX_AGE_MS)).toBe(false)
  })
})
