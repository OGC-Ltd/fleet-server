import { describe, expect, it } from 'vitest'
import { pickIncidentPoint, stretches, type TrackPoint } from '../../src/modules/fuel/fuel-investigation.js'

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
