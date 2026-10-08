import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: { geofence: { findMany: vi.fn(async () => []) } } }))
import { computeVisits, nestFences, uncoveredSites, type VisitFence } from '../../src/modules/usage-review/usage-review.visits.js'
import type { ReviewMessage, ReviewStop } from '../../src/modules/usage-review/usage-review.compute.js'

const box = (s: number, w: number, n: number, e: number): [number, number][] => [[w, s], [e, s], [e, n], [w, n], [w, s]]
const fence = (id: string, name: string, ring: [number, number][], areaHa: number): VisitFence =>
  ({ id, name, areaHa, source: 'fence', geometry: { type: 'POLYGON', polygonCoords: ring } })

// A made-up premises near Sukari, ~1.1 km square, with a yard and a weighbridge.
const premises = fence('P', 'Sukari Industries', box(-0.830, 34.380, -0.820, 34.390), 123)
const yard = fence('Y', 'Sukari Industries · Yard', box(-0.829, 34.381, -0.827, 34.383), 4.9)
const bridge = fence('W', 'Sukari Industries · Weighbridge', box(-0.825, 34.385, -0.824, 34.386), 1.2)
const FENCES = [premises, yard, bridge]

const T0 = Date.parse('2026-10-01T06:00:00+03:00') / 1000
const at = (h: number) => T0 + Math.round(h * 3600)
const YARD = { lat: -0.828, lng: 34.382 }
const BRIDGE = { lat: -0.8245, lng: 34.3855 }
const WORKSHOP = { lat: -0.822, lng: 34.388 }       // inside the premises, in no area
const MARKET = { lat: -0.800, lng: 34.420 }          // outside everything
const OUTSIDE = { lat: -0.835, lng: 34.375 }

/** Fixes every `step` seconds at a spot from hour a to hour b. */
function stay(p: { lat: number; lng: number }, a: number, b: number, step = 60): ReviewMessage[] {
  const out: ReviewMessage[] = []
  for (let t = at(a); t < at(b); t += step) out.push({ t, lat: p.lat, lng: p.lng, speed: 0, course: null, odoM: null, ign: null })
  return out
}

const period = { startMs: Date.parse('2026-10-01T00:00:00+03:00'), endMs: Date.parse('2026-10-02T00:00:00+03:00') }

describe('usage-review visits', () => {
  it('puts an area inside the premises that holds all of it', () => {
    const meta = nestFences(FENCES)
    expect(meta.find(m => m.id === 'Y')!.parentId).toBe('P')
    expect(meta.find(m => m.id === 'W')!.parentId).toBe('P')
    expect(meta.find(m => m.id === 'P')!.parentId).toBeNull()
    expect(meta.find(m => m.id === 'Y')!.depth).toBe(1)
  })

  it('follows a day in: yard → weighbridge → workshop, out, to the market', () => {
    const msgs = [
      ...stay(OUTSIDE, 0, 1),               // 06:00–07:00 outside
      ...stay(YARD, 1, 2),                  // 07:00–08:00 yard
      ...stay(BRIDGE, 2, 2.1),              // 08:00–08:06 weighbridge
      ...stay(WORKSHOP, 2.1, 4),            // 08:06–10:00 in the premises
      ...stay(MARKET, 4.5, 5.5),            // 10:30–11:30 at the market
    ]
    const stops: ReviewStop[] = [{ id: 1, start: at(4.5) * 1000, end: at(5.5) * 1000, min: 60, lat: MARKET.lat, lng: MARKET.lng, place: 2, overnight: false }]
    const r = computeVisits(msgs, period, FENCES, stops)

    const p = r.visits.find(v => v.fenceId === 'P')!
    const y = r.visits.find(v => v.fenceId === 'Y')!
    const w = r.visits.find(v => v.fenceId === 'W')!
    // Entry midway between the last fix outside (06:59) and the first inside (07:00).
    expect(new Date(p.start).toISOString()).toBe('2026-10-01T03:59:30.000Z')
    // Exit at the last fix inside (09:59): the next one is 31 minutes on,
    // too far to say when in between it left.
    expect(p.min).toBe(179.5)
    expect(y.parent).toBe(p.id)
    expect(w.parent).toBe(p.id)
    expect(w.min).toBeCloseTo(6, 0)
    // Yard → weighbridge → out of the premises.
    expect(y.next).toEqual({ kind: 'fence', id: 'W', visit: w.id })
    expect(w.next).toEqual({ kind: 'exit', id: 'P' })
    // Out of the premises (09:59), the market next, at 10:30.
    expect(p.next).toEqual({ kind: 'place', id: 2, stop: 1 })
    expect(p.toNextMin).toBe(31)

    const reg = r.register.find(x => x.fenceId === 'P')!
    expect(reg.visits).toBe(1)
    expect(reg.usualIn).toBe(7 * 60 - 1)     // 06:59:30, to the minute
    expect(reg.next[0]!.ref).toEqual({ kind: 'place', id: 2, stop: 1 })
  })

  it('joins over a moment outside the edge, and drops a drive through', () => {
    const msgs = [
      ...stay(OUTSIDE, 0, 1),
      ...stay(YARD, 1, 1.5),
      { t: at(1.5), lat: OUTSIDE.lat, lng: OUTSIDE.lng, speed: 0, course: null, odoM: null, ign: null },   // one jittered fix
      ...stay(YARD, 1.5 + 60 / 3600, 2),
      ...stay(OUTSIDE, 2, 3),
      // 08:00 back past the weighbridge: in it for one minute only.
      ...stay(BRIDGE, 3, 3 + 60 / 3600, 30),
      ...stay(OUTSIDE, 3 + 60 / 3600, 4),
    ]
    const r = computeVisits(msgs, period, FENCES, [])
    expect(r.visits.filter(v => v.fenceId === 'Y')).toHaveLength(1)
    expect(r.visits.filter(v => v.fenceId === 'W')).toHaveLength(0)
  })

  it('marks a visit the period began or ended inside', () => {
    const r = computeVisits(stay(YARD, -6, 3), period, FENCES, [])
    const y = r.visits.find(v => v.fenceId === 'Y')!
    expect(y.openStart).toBe(true)
    expect(y.openEnd).toBe(true)
    expect(y.next).toEqual({ kind: 'end' })
  })

  it('carries only the fences the unit went into, with their premises', () => {
    const far = fence('F', 'Elsewhere yard', box(-0.5, 34.5, -0.49, 34.51), 100)
    const r = computeVisits(stay(YARD, 1, 2), period, [...FENCES, far], [])
    expect(r.fences.map(f => f.id).sort()).toEqual(['P', 'Y'])
  })

  it('adds a known site only where no fence already stands', () => {
    expect(uncoveredSites([]).length).toBeGreaterThan(0)
    const sites = uncoveredSites([])
    const covering = sites.map((s, k) => ({ ...s, id: `c${k}`, source: 'fence' as const }))
    expect(uncoveredSites(covering)).toHaveLength(0)
  })
})
