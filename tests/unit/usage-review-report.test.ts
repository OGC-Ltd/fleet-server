import { describe, it, expect } from 'vitest'
import { reportFigures, shortPlaceName, median } from '../../src/modules/usage-review/usage-review.report.js'
import type { ReviewPlace, ReviewStop, ReviewTrip, ReviewDay } from '../../src/modules/usage-review/usage-review.compute.js'

const at = (day: number, h: number, m = 0) => Date.parse(`2026-09-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`)
const place = (id: number, name: string, hours: number, kind: ReviewPlace['kind']): ReviewPlace => ({
  id, lat: 0, lng: 0, hours, visits: 0, days: 0, share: 0, firstSeen: 0, lastSeen: 0,
  name, kind, area: null, county: null, country: null, address: null,
})
const stop = (id: number, p: number, a: number, b: number): ReviewStop => ({ id, start: a, end: b, min: (b - a) / 60_000, lat: 0, lng: 0, place: p, overnight: false })
const trip = (id: number, from: number, to: number, start: number, km: number, min: number): ReviewTrip => ({
  id, start, end: start + min * 60_000, min, driveMin: min, km, maxKmh: 60, avgKmh: 40,
  fromStop: 0, toStop: 0, fromPlace: from, toPlace: to, from: [0, 0], to: [0, 0],
})
const day = (date: string, km: number): ReviewDay => ({
  date, km, driveH: 1, engineH: null, idleH: null, maxKmh: 60, avgKmh: 40, moved: km >= 1, trips: 0, stops: 0,
  firstMove: null, lastMove: null, odoStartKm: null, odoEndKm: null, messages: 1, source: 'wialon',
})

// Home is two places (the yard and the house next to it); Kabras is work.
const places = [place(1, 'webuye town, Bungoma (NE, 0.3 km)', 100, 'home'), place(2, 'Kabras Sugar', 20, 'work'), place(3, 'webuye east', 5, 'home'), place(4, 'Milimani, Kisumu', 10, 'elsewhere')]
const stops = [
  stop(1, 1, at(1, 0), at(1, 7)),            // began at the period's start: no arrival
  stop(2, 2, at(1, 9), at(1, 12)),
  stop(3, 1, at(1, 14), at(2, 7)),
  stop(4, 2, at(2, 9, 30), at(2, 11)),
  stop(5, 4, at(2, 15), at(2, 20)),
]
// Tue 1 Sep and Wed 2 Sep 2026.
const trips = [
  trip(1, 1, 2, at(1, 7), 30, 40), trip(2, 2, 1, at(1, 12), 30, 45),
  trip(3, 1, 2, at(2, 7), 28, 38), trip(4, 2, 4, at(2, 13), 90, 120),
  trip(5, 3, 1, at(2, 21), 2, 6),
]
const rv = {
  places, stops, trips,
  days: [day('2026-09-01', 60), day('2026-09-02', 120), day('2026-09-03', 0)],
  summary: { driveH: 4.2, idleH: 0.5 } as never,
  period: { from: '2026-09-01', to: '2026-09-03', days: 3, startMs: at(1, 0), endMs: at(4, 0) },
}
const areas = { hours: { work: 20, home: 105, elsewhere: 10 }, nights: { work: 0, home: 2, elsewhere: 0 }, nightly: [], homePlace: 1 }

describe('usage-review report figures', () => {
  const f = reportFigures(rv, areas)

  it('names a place short: two parts, capitalised, no direction note', () => {
    expect(shortPlaceName(places[0]!)).toBe('Webuye Town, Bungoma')
    expect(shortPlaceName({ id: 9, name: null, exactName: 'Kabras Sugar - Gate' })).toBe('Kabras Sugar - Gate')
  })

  it('merges the home places into one home, named after its anchor', () => {
    expect(f.sites[0]!.name).toBe('Home (Webuye Town, Bungoma)')
    expect(f.sites[0]!.hours).toBe(105)
    expect(f.homeShare).toBeCloseTo(105 / 135, 6)
    expect(f.split).toEqual({ driving: 4.2, idling: 0.5, home: 105, away: 30 })
  })

  it('gives median arrival and departure, skipping a stop that began before the period', () => {
    const kabras = f.sites.find(x => x.name === 'Kabras Sugar')!
    expect(kabras.visits).toBe(2)
    expect(kabras.arrive).toBe(Math.round((9 * 60 + 9 * 60 + 30) / 2))
    expect(kabras.depart).toBe(Math.round((12 * 60 + 11 * 60) / 2))
    expect(f.sites[0]!.arrive).toBe(14 * 60)          // only the 14:00 arrival counts
  })

  it('groups trips into routes, home as one, and calls home → home a round trip', () => {
    const hk = f.routes.find(r => r.from.startsWith('Home') && r.to === 'Kabras Sugar')!
    expect(hk.trips).toBe(2)
    expect(hk.km).toBe(58)
    expect(f.routes.find(r => r.round)!.from).toMatch(/^Home/)
  })

  it('reads the week and the clock off trip starts', () => {
    expect(f.byWeekday[1]).toBe(2)        // Tuesday
    expect(f.byWeekday[2]).toBe(3)        // Wednesday
    expect(f.busiestDay).toBe(2)
    expect(f.peakHour).toBe(7)
    expect(f.beforeNoonShare).toBeCloseTo(2 / 5, 6)
  })

  it('writes the four findings from the figures', () => {
    expect(f.findings[0]!.text).toContain('Home holds 78%')
    expect(f.findings[0]!.text).toContain('Kabras Sugar (20 h)')
    expect(f.activeKm.median).toBe(90)
    expect(f.findings[1]!.text).toBe('Median active day 90 km; peak of 120 km on 02 Sep.')
    expect(f.findings[3]!.text).toContain('busiest day is Wednesday')
    expect(median([3, 1, 2])).toBe(2)
  })
})
