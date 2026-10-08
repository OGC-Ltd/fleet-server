import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: { geofence: { findMany: vi.fn(async () => []) } } }))
import { classifyPlaces, siteAt, STATIC_SITES } from '../../src/modules/usage-review/usage-review.areas.js'
import type { ReviewPlace, ReviewStop } from '../../src/modules/usage-review/usage-review.compute.js'

const place = (id: number, lat: number, lng: number, hours: number): ReviewPlace => ({
  id, lat, lng, hours, visits: 1, days: 1, share: 0, firstSeen: 0, lastSeen: 0,
  name: `P${id}`, area: null, county: null, country: null, address: null,
})
// 02:00 EAT on day d of Sep 2026 is 23:00 UTC the day before.
const night = (d: number) => Date.parse(`2026-09-${String(d).padStart(2, '0')}T02:00:00+03:00`)
const stop = (id: number, p: ReviewPlace, d: number): ReviewStop => ({
  id, start: night(d) - 5 * 3_600_000, end: night(d) + 4 * 3_600_000, min: 540, lat: p.lat, lng: p.lng, place: p.id, overnight: true,
})

describe('usage-review areas', () => {
  const home = place(1, 0.03284, 34.15056, 300)          // Kadenge, Siaya
  const nearHome = place(2, 0.02331, 34.17165, 200)      // 2.6 km from it
  const nzoia = place(3, 0.56972, 34.65396, 12)          // by the Nzoia CW bridge
  const webuye = place(4, 0.61397, 34.77047, 90)         // a town, no site
  const period = { from: '2026-09-01', to: '2026-09-07' }

  it('places a stop by the Nzoia weighbridge at a work site', () => {
    expect(siteAt(nzoia.lat, nzoia.lng, STATIC_SITES)).toMatch(/Nzoia/)
    expect(siteAt(webuye.lat, webuye.lng, STATIC_SITES)).toBe(null)
  })

  it('calls the most-nights place away from work, and its neighbours, the home area', () => {
    const stops = [stop(1, home, 1), stop(2, home, 2), stop(3, nearHome, 3), stop(4, home, 4), stop(5, webuye, 5), stop(6, nzoia, 6)]
    const { byPlace, summary } = classifyPlaces([home, nearHome, nzoia, webuye], stops, period, STATIC_SITES)
    expect(byPlace.get(1)!.kind).toBe('home')
    expect(byPlace.get(2)!.kind).toBe('home')
    expect(byPlace.get(3)!.kind).toBe('work')
    expect(byPlace.get(4)!.kind).toBe('elsewhere')
    expect(summary.homePlace).toBe(1)
    expect(summary.hours).toEqual({ home: 500, work: 12, elsewhere: 90 })
    expect(summary.nights).toEqual({ home: 4, work: 1, elsewhere: 1 })
    expect(summary.nightly.map(n => n.kind)).toEqual(['home', 'home', 'home', 'home', 'elsewhere', 'work', null])
  })

  it('names no home under three nights away from work', () => {
    const stops = [stop(1, home, 1), stop(2, home, 2), stop(3, nzoia, 3)]
    const { byPlace, summary } = classifyPlaces([home, nzoia], stops, period, STATIC_SITES)
    expect(summary.homePlace).toBe(null)
    expect(byPlace.get(1)!.kind).toBe('elsewhere')
  })
})
