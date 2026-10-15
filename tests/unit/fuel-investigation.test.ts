import { describe, expect, it } from 'vitest'
import { pickIncidentPoint, stretches, tripLeg, type TrackPoint } from '../../src/modules/fuel/fuel-investigation.js'

const T0 = Date.UTC(2026, 9, 15, 9, 0)
const min = (m: number) => T0 + m * 60_000
const pt = (m: number, lat: number, lng: number, gap = false): TrackPoint =>
  ({ t: min(m), lat, lng, spd: 0, eng: false, ...(gap ? { gapBefore: true as const } : {}) })

describe('pickIncidentPoint', () => {
  it('takes the last fix before the fall when it is recent', () => {
    const track = [pt(-30, -1, 36), pt(-2, -1.001, 36.001), pt(3, -1.001, 36.001)]
    const p = pickIncidentPoint(track, min(0), min(5))!
    expect(p.lat).toBe(-1.001)
    expect(p.offsetS).toBe(-120)
    expect(p.basis).toMatch(/began to fall/)
    expect(p.movedM).toBe(0)
  })

  it('falls back to the first fix inside the fall when the last one is stale', () => {
    const track = [pt(-40, -1, 36), pt(2, -1.01, 36.01)]
    const p = pickIncidentPoint(track, min(0), min(5))!
    expect(p.lat).toBe(-1.01)
    expect(p.basis).toMatch(/during the fall/)
  })

  it('says when no fix is close to the fall', () => {
    const p = pickIncidentPoint([pt(-50, -1, 36), pt(50, -1.2, 36)], min(0), min(5))!
    expect(p.basis).toMatch(/no fix close/)
  })

  it('reports how far the unit moved during the fall', () => {
    const track = [pt(-1, -1, 36), pt(2, -1, 36.01), pt(4, -1, 36)]
    expect(pickIncidentPoint(track, min(0), min(5))!.movedM).toBeGreaterThan(1000)
  })

  it('returns null with no fixes', () => {
    expect(pickIncidentPoint([], min(0), min(5))).toBeNull()
  })
})

describe('stretches', () => {
  it('splits at every silence and never bridges it', () => {
    const s = stretches([pt(0, 0, 0), pt(1, 0, 0), pt(20, 0, 0, true), pt(21, 0, 0)])
    expect(s.map((x) => x.length)).toEqual([2, 2])
  })
})

describe('tripLeg', () => {
  const yard = { lat: -0.8234, lng: 34.3845 }
  // ~0.01 deg is ~1.1 km: outside an 800 m yard.
  const inY = (m: number) => pt(m, -0.8234, 34.3845)
  const out = (m: number, k = 1) => pt(m, -0.8234 + 0.01 * k, 34.3845)

  it('without a dispatch takes the latest exit, still out', () => {
    const track = [inY(0), out(10), inY(30), inY(40), out(50), out(60, 3)]
    expect(tripLeg(track, yard, 800, null)).toEqual({ departed: 4, returned: null, atOrigin: false })
  })

  it('finds the return after the exit', () => {
    const track = [inY(0), out(10), out(20, 4), inY(90), inY(95)]
    expect(tripLeg(track, yard, 800, null)).toEqual({ departed: 1, returned: 3, atOrigin: true })
  })

  it('with a dispatch takes the first exit after it, not an earlier errand', () => {
    const track = [inY(0), out(5), inY(15), inY(60), out(70), out(80, 5)]
    expect(tripLeg(track, yard, 800, min(30)).departed).toBe(4)
  })

  it('a dispatched unit already out when the track opens left before it', () => {
    const track = [out(0, 2), out(10, 3)]
    expect(tripLeg(track, yard, 800, min(-60)).departed).toBe(0)
  })

  it('a unit that never left has no outing', () => {
    expect(tripLeg([inY(0), inY(10)], yard, 800, null)).toEqual({ departed: null, returned: null, atOrigin: true })
  })
})
