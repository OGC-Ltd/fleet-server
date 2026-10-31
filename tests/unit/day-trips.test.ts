/**
 * A vehicle's day cut into trips (trips/day-trips). Carried over from the
 * dashboard's own tests (new-ui lib/dayTrips.test.js).
 */
import { describe, it, expect } from 'vitest'
import { splitTrips, BREAK_MS, type Ping } from '../../src/modules/trips/day-trips.js'

const DAY = Date.parse('2026-10-30T00:00:00+03:00')
const M = 60_000, H = 60 * M

// About 0.009° of latitude per km. A ping a minute.
function drive(t0: number, minutes: number, lat0: number, lng: number, kmh = 40): Ping[] {
  const out: Ping[] = []
  for (let i = 0; i <= minutes; i++) out.push({ t: t0 + i * M, lat: lat0 + (i * kmh / 60) * 0.009, lng })
  return out
}
function park(t0: number, minutes: number, lat: number, lng: number): Ping[] {
  const out: Ping[] = []
  for (let i = 1; i <= minutes; i++) out.push({ t: t0 + i * M, lat, lng })
  return out
}

// 07:00 yard → 08:00 Raiply (40 km); parked 2 h; 10:00 back to the yard; a
// 10-minute stop at 10:30 stays inside the return trip.
const leg1 = drive(DAY + 7 * H, 60, 0.50, 34.9)
const end1 = leg1.at(-1)!
const stand = park(end1.t, 120, end1.lat, end1.lng)
const leg2a = drive(DAY + 10 * H, 30, end1.lat, 34.9, -40)
const end2a = leg2a.at(-1)!
const shortStop = park(end2a.t, 10, end2a.lat, end2a.lng)
const leg2b = drive(DAY + 10 * H + 41 * M, 30, end2a.lat, 34.9, -40)
const pings = [...leg1, ...stand, ...leg2a, ...shortStop, ...leg2b]

describe('splitTrips', () => {
  it('ends a trip on a stand of 30 min or more and keeps a short stop inside', () => {
    const trips = splitTrips(pings)
    expect(trips).toHaveLength(2)
    expect(trips[0]!.from).toBe(DAY + 7 * H)
    expect(trips[0]!.to).toBe(DAY + 8 * H)
    expect(trips[0]!.distanceM / 1000).toBeCloseTo(40, 0)
    expect(trips[1]!.from).toBe(DAY + 10 * H)
    expect(trips[1]!.to).toBe(DAY + 11 * H + 11 * M)
  })
  it('a stop just under the break joins the trips; at the break it splits them', () => {
    const a = drive(DAY, 20, 0.5, 34.9)
    const gap = (min: number) => drive(a.at(-1)!.t + min * M, 20, a.at(-1)!.lat, 34.9)
    expect(splitTrips([...a, ...gap(29)])).toHaveLength(1)
    expect(splitTrips([...a, ...gap(BREAK_MS / M + 1)])).toHaveLength(2)
  })
  it('shuffling about a yard is not a trip', () => {
    const yard: Ping[] = []
    for (let i = 0; i < 30; i++) yard.push({ t: DAY + i * M, lat: 0.5 + (i % 2) * 0.0003, lng: 34.9 })
    expect(splitTrips(yard)).toHaveLength(0)
  })
  it('takes the readings in any order', () => {
    expect(splitTrips([...pings].reverse())).toHaveLength(2)
  })
})
