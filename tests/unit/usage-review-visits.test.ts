/**
 * The Logbook's Site Visits (operator, 2026-10-09): each time the unit went
 * onto a site plan or a company geofence, when it arrived, the areas inside it
 * stood in and for how long, and when it left. Tested on the real surveys.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: { geofence: { findMany: vi.fn(async () => []) } } }))
import {
  loadSitePlans, nameStops, siteVisits, MIN_AREA_MS, MIN_GROUND_MS, MIN_VISIT_MS, VISIT_GAP_MS,
} from '../../src/modules/usage-review/usage-review.siteplans.js'
import type { Site } from '../../src/modules/usage-review/usage-review.areas.js'
import type { ReviewPoint, ReviewStop } from '../../src/modules/usage-review/usage-review.compute.js'

const plans = loadSitePlans()

const T0 = Date.UTC(2026, 9, 5, 4, 0)                    // 07:00 EAT
type LL = { lat: number; lng: number }
const at = (min: number, p: LL): ReviewPoint =>
  ({ t: T0 + min * 60_000, lat: p.lat, lng: p.lng, speed: 0, course: null, ign: null, odoKm: null, moving: false })
/** A fix every minute at `p`, for minutes [from, to]. */
const stay = (from: number, to: number, p: LL) => Array.from({ length: to - from + 1 }, (_, i) => at(from + i, p))

const WEBUYE = { lat: 0.61397, lng: 34.77047 }            // no site
const KABRAS_ROAD = { lat: 0.3740, lng: 34.8350 }         // ~350 m south of Kabras' fence
const MAIN_GATE = { lat: 0.376743, lng: 34.834710 }       // "Main Gate Tractor"
const GARAGE = { lat: 0.377382, lng: 34.838618 }
const WEIGHBRIDGE = { lat: 0.376914, lng: 34.834213 }
const RAIPLY = { lat: 0.535239, lng: 35.251126 }
const KABRAS_GROUND = { lat: 0.3790, lng: 34.8350 }       // inside the fence, no area or pin near
const min = (ms: number) => ms / 60_000

describe('siteVisits', () => {
  it('finds the visit: arrival, each area stood in and for how long, departure', () => {
    const pts = [
      ...stay(0, 10, KABRAS_ROAD),
      ...stay(12, 16, MAIN_GATE),
      ...stay(18, 138, GARAGE),
      ...stay(140, 160, WEIGHBRIDGE),
      ...stay(163, 170, KABRAS_ROAD),
    ]
    const [v, ...more] = siteVisits(pts, plans)
    expect(more).toHaveLength(0)
    expect(v).toMatchObject({ site: 'Kabras', from: 'site-plan', startsBefore: false, endsAfter: false })
    expect(min(v!.start - T0)).toBe(12)
    expect(min(v!.end - T0)).toBe(160)
    expect(v!.areas.map(a => [a.name, min(a.start - T0), min(a.end - T0)])).toEqual([
      ['Main Gate Tractor', 12, 16],
      ['Garage', 18, 138],
      ['Weighbridge', 140, 160],
    ])
  })

  it('keeps one visit through a short step outside, and a silent tracker', () => {
    const pts = [
      ...stay(0, 30, GARAGE),
      ...stay(31, 31 + VISIT_GAP_MS / 60_000 - 2, KABRAS_ROAD),   // out, back in time
      ...stay(45, 60, GARAGE),
      at(300, GARAGE),                                              // nothing for four hours, still there
    ]
    const visits = siteVisits(pts, plans)
    expect(visits).toHaveLength(1)
    expect(min(visits[0]!.end - T0)).toBe(300)
    expect(visits[0]!.areas.map(a => a.name)).toEqual(['Garage'])
  })

  it('makes two visits of a longer time away', () => {
    const pts = [...stay(0, 30, GARAGE), ...stay(31, 31 + VISIT_GAP_MS / 60_000 + 5, KABRAS_ROAD), ...stay(60, 90, GARAGE)]
    expect(siteVisits(pts, plans)).toHaveLength(2)
  })

  it('leaves out a drive past, and an area driven through', () => {
    const past = [...stay(0, 5, KABRAS_ROAD), ...stay(6, 6 + MIN_VISIT_MS / 60_000 - 2, MAIN_GATE), ...stay(10, 15, KABRAS_ROAD)]
    expect(siteVisits(past, plans)).toEqual([])

    const through = [...stay(0, 40, GARAGE), ...stay(41, 41 + MIN_AREA_MS / 60_000 - 1, WEIGHBRIDGE), ...stay(43, 80, GARAGE)]
    const [v] = siteVisits(through, plans)
    expect(v!.areas.map(a => [a.name, min(a.start - T0), min(a.end - T0)])).toEqual([['Garage', 0, 80]])
  })

  it("counts the site's own ground only when it stood there, not crossing it", () => {
    const pts = [
      ...stay(0, 60, GARAGE),
      ...stay(61, 61 + MIN_GROUND_MS / 60_000 - 2, KABRAS_GROUND),   // on the way out
      ...stay(70, 75, KABRAS_ROAD),
      ...stay(200, 260, GARAGE),
      ...stay(261, 261 + MIN_GROUND_MS / 60_000 + 20, KABRAS_GROUND), // parked there
    ]
    const [first, second] = siteVisits(pts, plans)
    expect(first!.areas.map(a => a.name)).toEqual(['Garage'])
    expect(second!.areas.map(a => a.name)).toEqual(['Garage', null])
  })

  it('says when it was already on the site at the start, and still there at the end', () => {
    const [v] = siteVisits(stay(0, 120, RAIPLY), plans)
    expect(v).toMatchObject({ site: 'Raiply', startsBefore: true, endsAfter: true })
    // Raiply has no named area where it stood: the visit row says it all.
    expect(v!.areas).toEqual([])
  })

  it("counts the organisation's own geofences", () => {
    const fences: Site[] = [{ name: 'Yard 3', fence: { type: 'CIRCLE', centerLat: WEBUYE.lat, centerLng: WEBUYE.lng, radiusM: 200 } }]
    const [v] = siteVisits([...stay(0, 5, KABRAS_ROAD), ...stay(60, 90, WEBUYE), ...stay(100, 110, KABRAS_ROAD)], plans, fences)
    expect(v).toMatchObject({ site: 'Yard 3', from: 'geofence', areas: [] })
    expect(min(v!.end - v!.start)).toBe(30)
  })

  it('reads a month of fixes quickly', () => {
    // 43,200 fixes, a minute apart, wandering round western Kenya.
    const pts = Array.from({ length: 43_200 }, (_, i) => at(i, {
      lat: 0.37 + 0.2 * Math.sin(i / 700), lng: 34.83 + 0.4 * Math.cos(i / 900),
    }))
    const t = performance.now()
    siteVisits(pts, plans)
    expect(performance.now() - t).toBeLessThan(3_000)
  })
})

// Movements names each stop by the spot it stood at: a place gathers every stop
// within 400 m, so "Vehicle Parking, Kabras" also held the garage next door.
describe('nameStops', () => {
  it('names a stop on the company ground by its own spot, and leaves the rest', () => {
    const stop = (id: number, p: { lat: number; lng: number }): ReviewStop =>
      ({ id, start: 0, end: 600_000, min: 10, lat: p.lat, lng: p.lng, place: 1, overnight: false })
    const stops = [stop(1, GARAGE), stop(2, WEIGHBRIDGE), stop(3, RAIPLY), stop(4, WEBUYE)]
    nameStops(stops, plans)
    expect(stops.map(s => s.spot)).toEqual(['Garage, Kabras', 'Weighbridge, Kabras', 'Raiply', null])
  })
})

describe('the Site Visits pages', () => {
  it('runs a long table on over pages under the running head, and never past the footer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))   // no map tiles
    const { buildUsageReview, dayStartMs } = await import('../../src/modules/usage-review/usage-review.compute.js')
    const { renderUsageReviewPdf } = await import('../../src/modules/usage-review/usage-review.pdf.js')

    const t0 = dayStartMs('2026-10-05') / 1000
    const msgs = Array.from({ length: 240 }, (_, i) => ({
      t: t0 + 6 * 3600 + i * 60, lat: GARAGE.lat, lng: GARAGE.lng + (i > 120 ? 0.05 : 0),
      speed: i === 120 ? 40 : 0, course: null, odoM: null, ign: null, src: 'wialon' as const,
    }))
    const rv = buildUsageReview(msgs, '2026-10-05', '2026-10-05')
    const hour = 3_600_000, start = dayStartMs('2026-10-05')
    const visits = Array.from({ length: 80 }, (_, i) => ({
      site: 'Kabras', from: 'site-plan' as const, start: start + i * hour, end: start + i * hour + 50 * 60_000,
      startsBefore: i === 0, endsAfter: false,
      areas: ['Main Gate Tractor', 'Garage', 'Weighbridge'].map((name, k) => ({ name, start: start + i * hour + k * 15 * 60_000, end: start + i * hour + (k + 1) * 15 * 60_000 })),
    }))
    const pdf = await renderUsageReviewPdf({
      ...rv, siteVisits: visits, builtAt: start, incompleteDays: [], wialonError: null,
      vehicle: { vehicleId: 'v', plate: 'KDE 585S', name: null, vehicleType: null, wialonUnitId: 1, wialonName: null, organisation: 'West Kenya Sugar', kmpl: null, kmplSource: null },
    } as never, null, null)

    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
    // 80 visits of four rows at 15 pt: well over two pages of table.
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0
    expect(pages).toBeGreaterThanOrEqual(6)
    vi.unstubAllGlobals()
  })
})
