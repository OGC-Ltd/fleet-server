import { describe, it, expect } from 'vitest'
import { fenceBox, inBox, isInsideCorridor, isInsideFence, type FenceGeometry } from '../../src/lib/geofence.js'

/**
 * The box and the corridor's segment skip are speed, never a different answer.
 *
 * Mufindi's 97 zones cost the day-series route up to a second (27 Sep), so the
 * zone loop now tries each zone's box first and the corridor skips segments
 * that cannot be near. Both are checked here against the exact tests on many
 * points around real-sized shapes: nothing inside a fence may fall outside its
 * box, and the corridor must agree with the old per-segment loop everywhere.
 */

// Deterministic, so a failure reproduces.
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
}

/** The corridor test as it was before the segment skip. */
function corridorBefore(lat: number, lng: number, path: [number, number][], widthM: number): boolean {
  if (path.length === 0) return false
  const tol = Math.max(widthM, 1) / 2
  const M = 111_320
  const dist = (aLat: number, aLng: number, bLat: number, bLng: number) => {
    const k = M * Math.cos((lat * Math.PI) / 180)
    const px = (lng - aLng) * k, py = (lat - aLat) * M, bx = (bLng - aLng) * k, by = (bLat - aLat) * M
    const len = bx * bx + by * by
    if (len === 0) return Math.hypot(px, py)
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / len))
    return Math.hypot(px - t * bx, py - t * by)
  }
  if (path.length === 1) return isInsideCorridor(lat, lng, path, widthM)
  for (let i = 1; i < path.length; i++) {
    const [aLng, aLat] = path[i - 1]!, [bLng, bLat] = path[i]!
    if (dist(aLat, aLng, bLat, bLng) <= tol) return true
  }
  return false
}

// Shapes at Mufindi's latitude (-8.5) and at the equator, where the Kenyan fleets are.
function shapes(r: () => number, lat0: number, lng0: number): FenceGeometry[] {
  const ring: [number, number][] = []
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * 2 * Math.PI, rad = 0.01 + r() * 0.01
    ring.push([lng0 + Math.cos(a) * rad, lat0 + Math.sin(a) * rad])
  }
  const path: [number, number][] = []
  let lng = lng0 - 0.03, lat = lat0 - 0.02
  for (let i = 0; i < 60; i++) { lng += 0.001 + r() * 0.0005; lat += (r() - 0.5) * 0.0015; path.push([lng, lat]) }
  return [
    { type: 'POLYGON', polygonCoords: ring },
    { type: 'CIRCLE', centerLat: lat0, centerLng: lng0, radiusM: 350 },
    { type: 'LINE', pathCoords: path, widthM: 30 },
    { type: 'LINE', pathCoords: [[lng0, lat0]], widthM: 40 },
  ]
}

describe('fenceBox', () => {
  for (const [lat0, lng0] of [[-8.5, 35.3], [0.3, 34.6]] as const) {
    it(`holds every point the exact test calls inside (lat ${lat0})`, () => {
      const r = rng(7)
      for (const fence of shapes(r, lat0, lng0)) {
        const box = fenceBox(fence)
        let inside = 0
        for (let i = 0; i < 20_000; i++) {
          const lat = lat0 + (r() - 0.5) * 0.08, lng = lng0 + (r() - 0.5) * 0.08
          if (isInsideFence(lat, lng, fence)) {
            inside++
            expect(inBox(box, lat, lng)).toBe(true)
          }
        }
        expect(inside).toBeGreaterThan(0)
      }
    })
  }

  it('is an empty box for a corridor with no path, which contains nothing', () => {
    const box = fenceBox({ type: 'LINE', pathCoords: [], widthM: 20 })
    expect(inBox(box, 0, 0)).toBe(false)
  })
})

describe('isInsideCorridor with the segment skip', () => {
  for (const [lat0, lng0] of [[-8.5, 35.3], [0.3, 34.6]] as const) {
    it(`agrees with the per-segment loop everywhere (lat ${lat0})`, () => {
      const r = rng(11)
      const line = shapes(r, lat0, lng0)[2] as Extract<FenceGeometry, { type: 'LINE' }>
      let hits = 0
      for (let i = 0; i < 20_000; i++) {
        const lat = lat0 - 0.02 + (r() - 0.5) * 0.03, lng = lng0 + (r() - 0.5) * 0.08
        const want = corridorBefore(lat, lng, line.pathCoords, line.widthM)
        expect(isInsideCorridor(lat, lng, line.pathCoords, line.widthM)).toBe(want)
        if (want) hits++
      }
      expect(hits).toBeGreaterThan(0)
    })
  }

  it('still finds a point exactly on the centre-line', () => {
    expect(isInsideCorridor(-8.5, 35.3, [[35.29, -8.5], [35.31, -8.5]], 10)).toBe(true)
  })
})
