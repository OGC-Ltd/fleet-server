/**
 * The simplifier exists because the map track's 15 m distance rule throws away
 * corners. These tests pin the properties that difference turns on: a corner
 * survives, a straight run collapses, a parked unit's jitter is removed, and
 * nothing is ever simplified across a reporting silence.
 */

import { describe, it, expect } from 'vitest'
import {
  simplifyPath, STATIONARY_KMH, DWELL_RADIUS_M, type PathPoint,
} from '../../src/lib/simplify-path.js'

// Kasulu-ish, so the cos(lat) term is exercised rather than sitting at 1.
const LAT0 = -0.28
const LNG0 = 34.75
const M_PER_DEG_LAT = 110_574
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)

/** A point `northM`/`eastM` from the origin, moving unless told otherwise. */
const at = (northM: number, eastM: number, extra: Partial<PathPoint> = {}): PathPoint => ({
  lat: LAT0 + northM / M_PER_DEG_LAT,
  lng: LNG0 + eastM / mPerDegLng(LAT0),
  speedKmh: 20,
  ...extra,
})

/**
 * Metres from a point to the nearest segment of a polyline.
 *
 * Deliberately a SECOND implementation rather than importing the module's own
 * `perpendicularM` — a test that measures with the code under test cannot fail
 * when that code's geometry is wrong. Plain planar maths on the same local
 * projection the fixture was built in.
 */
function distanceToPolylineM(p: PathPoint, line: PathPoint[]): number {
  const x = (q: PathPoint) => (q.lng - LNG0) * mPerDegLng(LAT0)
  const y = (q: PathPoint) => (q.lat - LAT0) * M_PER_DEG_LAT
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const ax = x(line[i - 1]), ay = y(line[i - 1])
    const bx = x(line[i]) - ax, by = y(line[i]) - ay
    const px = x(p) - ax,       py = y(p) - ay
    const len2 = bx * bx + by * by
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2))
    best = Math.min(best, Math.hypot(px - t * bx, py - t * by))
  }
  return best
}

describe('straight runs collapse, corners do not', () => {
  it('reduces a straight line to its two endpoints however many fixes it holds', () => {
    // 50 fixes along one bearing — a haul road at a 28 s cadence.
    const line = Array.from({ length: 50 }, (_, i) => at(i * 20, 0))
    const out = simplifyPath(line, { toleranceM: 5 })

    expect(out).toHaveLength(2)
    expect(out[0]).toBe(line[0])
    expect(out[1]).toBe(line[49])
  })

  it('keeps the vertex of a right-angle turn', () => {
    // 500 m north (11 fixes, 0..500 inclusive), then 500 m east. The corner
    // point must exist IN the input for the test to be about the simplifier —
    // stopping the first leg at 450 and starting the second at (500, 50) tests
    // nothing but the fixture.
    const north = Array.from({ length: 11 }, (_, i) => at(i * 50, 0))
    const east  = Array.from({ length: 10 }, (_, i) => at(500, (i + 1) * 50))
    const path  = [...north, ...east]
    const out   = simplifyPath(path, { toleranceM: 5 })

    // The vertex is 250 m off the chord through the whole path — no tolerance
    // this side of absurd may drop it.
    expect(out).toContain(north[10])
    // Two straight legs and one corner is the whole shape.
    expect(out).toHaveLength(3)
  })

  /**
   * The property the 15 m distance rule cannot have. A machine working at
   * 1-10 km/h steps a few metres at a time, so a "keep it if it is 15 m from
   * the last kept point" rule discards most of a turn's intermediate fixes and
   * with them the turn. Douglas-Peucker measures against the CHORD, so the
   * deviation is what decides — and a 40 m bulge is not noise.
   */
  /**
   * The GUARANTEE, rather than a point count.
   *
   * Douglas-Peucker promises that no discarded point lies further than the
   * tolerance from the line that replaces it. Asserting that directly is worth
   * more than asserting a length, because the length depends on the fixture's
   * curvature in a way that invites fitting the expectation to whatever the
   * code happened to return. Checked at two tolerances so the relationship is
   * shown to hold rather than to coincide.
   */
  it.each([2, 5, 10])('leaves no fix further than %d m from the drawn line', (tol) => {
    const arc: PathPoint[] = []
    for (let i = 0; i <= 60; i++) {
      const a = (Math.PI / 2) * (i / 60)
      arc.push(at(60 * Math.sin(a), 60 * (1 - Math.cos(a)), { speedKmh: 4 }))
    }
    const out = simplifyPath(arc, { toleranceM: tol, dwellRadiusM: 0 })

    expect(Math.max(...arc.map(p => distanceToPolylineM(p, out)))).toBeLessThanOrEqual(tol)
  })

  it('follows a slow machine\'s arc instead of flattening it to a chord', () => {
    // Every consecutive pair here is ~1.6 m apart — far inside the 15 m spacing
    // rule, which would therefore keep roughly one fix in nine and cut the
    // curve into chords. The sagitta arithmetic says what to expect instead:
    // the arc bulges 60·(1−cos45°) = 17.6 m off its chord, so the apex is kept;
    // each remaining half bulges 60·(1−cos22.5°) = 4.6 m, which is inside a 5 m
    // corridor, so the recursion stops there. Three points, and 3 is the RIGHT
    // answer rather than a tolerated one.
    const arc: PathPoint[] = []
    for (let i = 0; i <= 60; i++) {
      const a = (Math.PI / 2) * (i / 60)
      arc.push(at(60 * Math.sin(a), 60 * (1 - Math.cos(a)), { speedKmh: 4 }))
    }
    const out = simplifyPath(arc, { toleranceM: 5, dwellRadiusM: 0 })

    expect(out).toHaveLength(3)
    expect(out[1]).toBe(arc[30])          // the apex, not an arbitrary survivor
    // Tighten the corridor and the curve gains detail — the behaviour a
    // distance rule cannot produce at all, since its output is independent of
    // how far the path bends.
    expect(simplifyPath(arc, { toleranceM: 1, dwellRadiusM: 0 }).length)
      .toBeGreaterThan(out.length)
  })
})

describe('dwell collapse', () => {
  it('removes a stopped unit\'s repeat fixes but keeps where it ended up', () => {
    const parked = Array.from({ length: 200 }, (_, i) =>
      // A metre of jitter, engine off, going nowhere.
      at((i % 3) - 1, (i % 2) - 0.5, { speedKmh: 0 }))
    const out = simplifyPath(parked, { toleranceM: 5, dwellRadiusM: DWELL_RADIUS_M })

    expect(out.length).toBeLessThanOrEqual(3)
    // The final fix survives, so a parked unit's track does not end at the
    // moment it arrived.
    expect(out[out.length - 1]).toBe(parked[parked.length - 1])
  })

  it('does not treat a SLOW unit as a stopped one', () => {
    // 4 km/h is above STATIONARY_KMH, so these are travel, not dwell — even
    // though each step is well inside the dwell radius.
    const crawl = Array.from({ length: 40 }, (_, i) => at(i * 4, 0, { speedKmh: 4 }))
    const out = simplifyPath(crawl, { toleranceM: 5, dwellRadiusM: 50 })

    // Collinear, so it still reduces to endpoints — but via Douglas-Peucker,
    // which means the LAST point is the real last fix rather than a survivor of
    // a dwell that never happened.
    expect(out[0]).toBe(crawl[0])
    expect(out[out.length - 1]).toBe(crawl[39])
    expect(STATIONARY_KMH).toBeLessThan(4)
  })

  it('never treats an unknown speed as stopped', () => {
    // speedKmh is 100% populated today; a null arriving later must not delete a
    // journey. These sit inside the dwell radius but must all be considered.
    const unknown = Array.from({ length: 20 }, (_, i) => at(i * 2, 0, { speedKmh: null }))
    const out = simplifyPath(unknown, { toleranceM: 5, dwellRadiusM: 100 })

    expect(out[0]).toBe(unknown[0])
    expect(out[out.length - 1]).toBe(unknown[19])
  })
})

describe('reporting silences', () => {
  it('never simplifies across a gap, and preserves the flag', () => {
    // Two straight runs 5 km apart. Without the run split, Douglas-Peucker
    // would see one nearly-straight line and could drop the point either side
    // of the silence — drawing a journey nothing was recorded for.
    const path: PathPoint[] = [
      ...Array.from({ length: 10 }, (_, i) => at(i * 20, 0)),
      ...Array.from({ length: 10 }, (_, i) => at(5000 + i * 20, 0, ...(i === 0 ? [{ gapBefore: true as const }] : []))),
    ]
    const out = simplifyPath(path, { toleranceM: 5 })

    const gapPoint = out.find(p => p.gapBefore)
    expect(gapPoint).toBeDefined()
    // Both runs kept their own endpoints: 2 + 2.
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(path[0])
    expect(out[out.length - 1]).toBe(path[path.length - 1])
  })
})

describe('degenerate input', () => {
  it('returns short paths untouched', () => {
    expect(simplifyPath([])).toEqual([])
    const one = [at(0, 0)]
    expect(simplifyPath(one)).toEqual(one)
    const two = [at(0, 0), at(10, 0)]
    expect(simplifyPath(two)).toEqual(two)
  })

  /**
   * The endpoint exposes toleranceM/dwellRadiusM so a caller can ask for the
   * unsimplified path and see what the simplifier removed. Zero has to be a
   * true no-op for that answer to mean anything.
   *
   * The fixture is DELIBERATELY collinear with duplicates in it. An earlier
   * version of this test stepped `lng` by `i % 2`, so no three points ever lay
   * on one line — it passed against a version of the code that dropped every
   * collinear point at tolerance 0, because Douglas-Peucker's test is
   * `farthest > tolerance` and a point exactly on the chord fails it at any
   * tolerance including zero. Against real telemetry that bug turned 15,210
   * fixes into 11,754 "unsimplified" points.
   */
  it('keeps everything at tolerance 0, collinear and duplicate points included', () => {
    const path = [
      ...Array.from({ length: 25 }, (_, i) => at(i * 20, 0)),   // exactly collinear
      ...Array.from({ length: 5 },  () => at(480, 0)),          // exact duplicates
    ]
    const out = simplifyPath(path, { toleranceM: 0, dwellRadiusM: 0 })
    expect(out).toHaveLength(path.length)
  })

  it('still collapses dwell at tolerance 0, because the two knobs are separate', () => {
    // Turning the shape simplifier off is not a request to keep 200 fixes from
    // a parked machine — that is what dwellRadiusM is for, and it is still set.
    const parked = Array.from({ length: 50 }, () => at(0, 0, { speedKmh: 0 }))
    const out = simplifyPath(parked, { toleranceM: 0, dwellRadiusM: 15 })
    expect(out.length).toBeLessThan(parked.length)
  })
})
