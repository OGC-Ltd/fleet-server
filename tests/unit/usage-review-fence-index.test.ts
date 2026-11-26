/**
 * The Logbook tests every fix against the organisation's geofences
 * (usage-review.siteplans spotAt, siteVisits). On 26 Nov 2026 a 3-month review
 * of one unit had 241,009 distinct fixes and the organisation 3,106 fences.
 * Testing each fix against each fence took 145 s with the event loop held, so
 * the report worker lost its job's lock and the review was built three times.
 * The fences are now indexed by a grid. These tests hold the index to the
 * answers the full scan gave, and to the time it may take.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: { geofence: { findMany: vi.fn(async () => []) } } }))
import { spotAt, siteVisits } from '../../src/modules/usage-review/usage-review.siteplans.js'
import { isInsideFence, pointInPolygon } from '../../src/lib/geofence.js'
import { ringAreaHa } from '../../src/lib/zone-taxonomy.js'
import type { Site } from '../../src/modules/usage-review/usage-review.areas.js'
import type { ReviewPoint } from '../../src/modules/usage-review/usage-review.compute.js'

let seed = 11
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647

/** A square fence `sideM` across, or a circle `sideM` wide, at lat/lng. */
function fence(i: number, lat: number, lng: number, sideM: number, circle: boolean): Site {
  if (circle) return { name: `C${i}`, fence: { type: 'CIRCLE', centerLat: lat, centerLng: lng, radiusM: sideM / 2 } }
  const d = sideM / 2 / 111_320, e = d / Math.cos(lat * Math.PI / 180)
  return {
    name: `P${i}`,
    fence: { type: 'POLYGON', polygonCoords: [[lng - e, lat - d], [lng + e, lat - d], [lng + e, lat + d], [lng - e, lat + d], [lng - e, lat - d]] },
  }
}

/** Fences over Menengai's ground: yards, fields and depots, some nested, some overlapping, some too big to name a place. */
function fleetOfFences(n: number): Site[] {
  const out: Site[] = []
  for (let i = 0; i < n; i++) {
    const lat = -0.6 + rnd() * 1.2, lng = 35.6 + rnd() * 1.2
    // Mostly small, a few up to 6 km across (over MAX_NAMING_FENCE_HA, so never a name).
    const side = rnd() < 0.05 ? 3_000 + rnd() * 3_000 : 50 + rnd() * 1_500
    out.push(fence(i, lat, lng, side, rnd() < 0.3))
  }
  // A corridor, which never names a place.
  out.push({ name: 'Road', fence: { type: 'LINE', pathCoords: [[35.6, -0.6], [36.8, 0.6]], widthM: 200 } })
  return out
}

const haOf = new Map<Site, number>()
const ha = (s: Site) => {
  let v = haOf.get(s)
  if (v === undefined) {
    const f = s.fence!
    v = f.type === 'CIRCLE' ? (Math.PI * f.radiusM ** 2) / 10_000 : f.type === 'POLYGON' ? ringAreaHa(f.polygonCoords) : Infinity
    haOf.set(s, v)
  }
  return v
}

/** The answer of the full scan the index replaced: every fence, smallest first. */
function scan(lat: number, lng: number, fences: Site[]): string | null {
  const inside = (s: Site) => {
    const f = s.fence!
    return f.type === 'POLYGON' ? pointInPolygon(lat, lng, f.polygonCoords) : isInsideFence(lat, lng, f)
  }
  return fences.filter(s => s.fence && ha(s) <= 2_000 && inside(s)).sort((a, b) => ha(a) - ha(b))[0]?.name ?? null
}

describe('the fence index', () => {
  const fences = fleetOfFences(3_000)

  it('names every point exactly as testing every fence did', () => {
    let named = 0
    for (let i = 0; i < 4_000; i++) {
      // Half the points near a fence, so the answers are not all "none".
      const f = fences[Math.floor(rnd() * (fences.length - 1))]!.fence!
      const near = f.type === 'CIRCLE' ? { lat: f.centerLat, lng: f.centerLng } : f.type === 'POLYGON' ? { lat: f.polygonCoords[0]![1], lng: f.polygonCoords[0]![0] } : null
      const lat = near && i % 2 ? near.lat + (rnd() - 0.5) * 0.02 : -0.6 + rnd() * 1.2
      const lng = near && i % 2 ? near.lng + (rnd() - 0.5) * 0.02 : 35.6 + rnd() * 1.2
      const want = scan(lat, lng, fences)
      expect(spotAt(lat, lng, [], fences)?.site ?? null).toBe(want)
      if (want) named++
    }
    expect(named).toBeGreaterThan(200)
  }, 60_000)

  it('names a point on a cell edge, and inside a fence that spans cells', () => {
    const big = fence(0, 0.02, 36.02, 1_800, false)
    const list = [big]
    expect(spotAt(0.02, 36.02, [], list)?.site).toBe('P0')
    expect(spotAt(0.0275, 36.0125, [], list)?.site).toBe('P0')
    expect(spotAt(0.04, 36.04, [], list)).toBeNull()
  })

  it('reads 240,000 distinct fixes against 3,000 fences in seconds, not minutes', () => {
    const points: ReviewPoint[] = []
    for (let i = 0; i < 240_000; i++) {
      points.push({ t: i * 30_000, lat: -0.6 + rnd() * 1.2, lng: 35.6 + rnd() * 1.2, speed: 0, course: null, ign: null, odoKm: null, moving: false })
    }
    const t0 = performance.now()
    siteVisits(points, [], fences)
    expect(performance.now() - t0).toBeLessThan(5_000)
  })
})
