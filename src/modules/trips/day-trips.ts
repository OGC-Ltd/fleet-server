// One day of a vehicle, cut into trips (operator, 2026-10-30: pick a day, see
// that day's trips, report on one of them). Pure: the readings come in, trips
// go out. Moved here from the dashboard (new-ui lib/dayTrips) so the report is
// made on the server; trip-report.service gathers the readings.
//
// ## What a trip is
//
// Driving, until the unit has stood still for BREAK_MS. A short stop (fuel,
// traffic, a gate) stays inside the trip; a long one ends it. Standing is
// measured by POSITION, as Playback's legs are, because some units report a
// dead speed line. A trip that covers less than MIN_TRIP_M is moving about a
// yard, not a journey, and is left out.

import { haversineM } from '../../lib/dispatch-trip.js'

export const BREAK_MS = 30 * 60_000
export const MIN_TRIP_M = 500
/** Below this a segment is standing: walking pace, or drift under 40 m. */
const MOVING_KMH = 3
const MOVING_MIN_M = 40

export interface Ping { t: number; lat: number; lng: number }
export interface Trip { from: number; to: number; distanceM: number }

const ok = (p: Ping) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)

/** The day's trips, in time order. `pings` may come in any order. */
export function splitTrips(pings: Ping[], { breakMs = BREAK_MS, minM = MIN_TRIP_M } = {}): Trip[] {
  const pts = pings.filter(ok).sort((a, b) => a.t - b.t)
  const trips: Trip[] = []
  let cur: Trip | null = null
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!
    const dt = b.t - a.t
    if (dt <= 0) continue
    const m = haversineM(a, b)
    const moving = m >= MOVING_MIN_M && (m / 1000) / (dt / 3_600_000) >= MOVING_KMH
    if (!moving) continue
    // A long silence or a long stand since the last movement ends the trip.
    if (cur && a.t - cur.to >= breakMs) { trips.push(cur); cur = null }
    if (!cur) cur = { from: a.t, to: b.t, distanceM: 0 }
    cur.to = b.t
    cur.distanceM += m
  }
  if (cur) trips.push(cur)
  return trips.filter(x => x.distanceM >= minM)
}
