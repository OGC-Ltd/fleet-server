/**
 * Thinning a GPS track without destroying its shape.
 *
 * ## Why not the distance rule the map track uses
 *
 * `findTrack` keeps a fix only once it is `minSpacingM` (15 m by default) from
 * the last one kept. That rule is well aimed at the thing it was written for
 * and badly aimed at everything else. Measured fleet-wide over 6 h:
 *
 *   speed band          consecutive pairs   step under 15 m
 *   stopped (<1 km/h)              56,718            93.9%
 *   slow 1-10 (plant)              18,174            56.0%
 *   10-30                          21,879            23.9%
 *   30+                             5,732             2.2%
 *
 * The 93.9% is the rule working: 46% of all consecutive pairs move less than a
 * METRE, because units report on a timer and a parked machine emits hundreds of
 * fixes at one spot. Dropping those is the whole point.
 *
 * The 56% is the damage. A machine working at 1-10 km/h — an excavator slewing,
 * a dozer pushing — has over half its steps thrown away, and a distance rule
 * cannot tell a turn from a straight run, so what it throws away includes the
 * corners. The path that comes back has the right endpoints and the wrong shape.
 * Above 30 km/h the rule is simply inert.
 *
 * ## Two passes, because there are two different problems
 *
 * DWELL COLLAPSE answers "the unit is parked and still talking". Speed-gated,
 * so it can only ever fire on a unit that is not moving; a slow machine is not
 * a stopped one and is never touched by this pass.
 *
 * DOUGLAS-PEUCKER answers "which of these moving fixes describe the shape".
 * It keeps the point furthest from the chord and recurses, so a corner survives
 * at any speed and a straight run collapses to its endpoints however many fixes
 * it contains. That is the property a distance rule cannot have: it measures
 * against the LINE being drawn rather than against the previous point.
 *
 * Order matters. Douglas-Peucker alone leaves a parked unit's GPS jitter in
 * place — the chord through a stationary cluster has near-zero length, so every
 * jittered fix reads as far from it — which is exactly the 46% the old rule was
 * right to remove.
 */

/** The minimum a point must carry to be simplified. */
export interface PathPoint {
  lat: number
  lng: number
  /** km/h. Null/undefined means unknown, which is NOT treated as stopped. */
  speedKmh?: number | null
  /**
   * The unit went quiet before this point. A run boundary: nothing may be
   * simplified ACROSS it, because there is no evidence of what happened in
   * between and a chord drawn over the silence would invent it.
   */
  gapBefore?: true
}

/**
 * At or below this, a unit counts as stopped for the dwell pass.
 *
 * 1 km/h is 0.28 m/s. Below that a "movement" over a 28 s reporting interval is
 * under 8 m, which is inside GPS noise for these trackers — and `accuracy_m` is
 * null on every row in this fleet, so noise cannot be identified any other way.
 */
export const STATIONARY_KMH = 1

/** How far a stopped unit may wander before a fix is kept anyway. */
export const DWELL_RADIUS_M = 15

/**
 * Perpendicular corridor Douglas-Peucker is allowed to cut.
 *
 * 5 m is about half a vehicle length: tight enough that a real turn survives,
 * loose enough that a straight haul road does not keep a fix every 28 s.
 */
export const SIMPLIFY_TOLERANCE_M = 5

const R = 6371000
const RAD = Math.PI / 180

/**
 * Metres from `p` to the segment `a`->`b`, on a local flat projection.
 *
 * Equirectangular about `a`, matching `metresBetween` in telemetry.repository —
 * over the span of one segment the error is far below the tolerance being
 * tested against, and a spherical cross-track formula would cost more than the
 * precision is worth here.
 *
 * A degenerate segment (a and b at the same place, which a stationary cluster
 * produces) reduces to the distance from `p` to `a`, which is the right answer
 * rather than a divide-by-zero.
 */
function perpendicularM(p: PathPoint, a: PathPoint, b: PathPoint): number {
  const kx = RAD * R * Math.cos(a.lat * RAD)
  const ky = RAD * R
  const px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky
  const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky
  const len2 = bx * bx + by * by
  if (len2 === 0) return Math.hypot(px, py)
  // Clamped, so a point beyond either end measures to the ENDPOINT rather than
  // to the infinite line — an unclamped projection understates the distance of
  // a fix that doubles back, and a doubling-back fix is precisely a corner.
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2))
  return Math.hypot(px - t * bx, py - t * by)
}

/** Metres between two points, same projection. */
function metresBetween(a: PathPoint, b: PathPoint): number {
  const dx = (b.lng - a.lng) * RAD * R * Math.cos(a.lat * RAD)
  const dy = (b.lat - a.lat) * RAD * R
  return Math.hypot(dx, dy)
}

/**
 * Drop fixes a STOPPED unit emitted without going anywhere.
 *
 * Gated on speed, not only on distance: a machine crawling at 3 km/h covers
 * about 23 m between fixes at this fleet's 28 s cadence, so a pure distance gate
 * would sometimes catch it and sometimes not depending on cadence jitter. Speed
 * is the thing actually being asked about.
 *
 * Unknown speed is never treated as stopped — `speedKmh` is 100% populated
 * today, but a null arriving later must not silently delete a journey.
 */
function collapseDwell<T extends PathPoint>(points: T[], radiusM: number): T[] {
  if (points.length === 0) return []
  const out: T[] = [points[0]]
  let anchor = points[0]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const stopped = typeof p.speedKmh === 'number' && p.speedKmh <= STATIONARY_KMH
    // A gap always survives: it carries the information that the line must be
    // broken here, and that cannot be re-derived once the point is gone.
    if (!p.gapBefore && stopped && metresBetween(anchor, p) < radiusM) continue
    out.push(p)
    anchor = p
  }
  // The LAST fix of a dwell is worth keeping even though the rule above drops
  // it: without it a unit that parks and stays parked has its track end at the
  // moment it arrived, and the playback cursor would run out of points long
  // before the day does.
  const last = points[points.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * Douglas-Peucker over one run.
 *
 * Iterative with an explicit stack rather than recursive: the worst case for
 * this algorithm is O(n) depth, and a day from the busiest unit in this fleet
 * is 15,210 fixes — enough to overflow the call stack on a shape that happens
 * to split badly.
 */
function douglasPeucker<T extends PathPoint>(points: T[], toleranceM: number): T[] {
  const n = points.length
  if (n <= 2) return points.slice()

  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1

  const stack: number[] = [0, n - 1]
  while (stack.length) {
    const hi = stack.pop()!
    const lo = stack.pop()!
    if (hi - lo < 2) continue

    let far = -1
    let farD = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicularM(points[i], points[lo], points[hi])
      if (d > farD) { farD = d; far = i }
    }
    if (farD > toleranceM) {
      keep[far] = 1
      stack.push(lo, far, far, hi)
    }
  }

  const out: T[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

export interface SimplifyOptions {
  toleranceM?: number
  dwellRadiusM?: number
}

/**
 * Dwell collapse, then Douglas-Peucker per run.
 *
 * Runs are split on `gapBefore` and simplified independently, so no chord is
 * ever drawn across a silence. The flag rides on the first point of each run
 * and is preserved, because the client draws a dotted connector from it.
 */
export function simplifyPath<T extends PathPoint>(
  points: T[], opts: SimplifyOptions = {},
): T[] {
  const toleranceM   = opts.toleranceM   ?? SIMPLIFY_TOLERANCE_M
  const dwellRadiusM = opts.dwellRadiusM ?? DWELL_RADIUS_M
  if (points.length <= 2) return points.slice()

  const dwelt = collapseDwell(points, dwellRadiusM)

  // Tolerance 0 means OFF, and has to be short-circuited rather than passed
  // through. Douglas-Peucker's test is `farthest > tolerance`, so at zero it
  // still discards every point that lies exactly ON its chord — duplicates and
  // collinear runs, which real telemetry is full of. Measured against
  // MUFINDI - CTR 03 for 2026-08-27: 15,210 fixes came back as 11,754 points
  // from a call that had asked for no simplification at all.
  //
  // That matters beyond tidiness. `toleranceM=0` is the endpoint's way of
  // answering "what did the simplifier remove", and an answer that has already
  // removed 23% of the fixes cannot settle the question.
  if (toleranceM <= 0) return dwelt

  const out: T[] = []
  let runStart = 0
  for (let i = 1; i <= dwelt.length; i++) {
    const boundary = i === dwelt.length || dwelt[i].gapBefore
    if (!boundary) continue
    out.push(...douglasPeucker(dwelt.slice(runStart, i), toleranceM))
    runStart = i
  }
  return out
}
