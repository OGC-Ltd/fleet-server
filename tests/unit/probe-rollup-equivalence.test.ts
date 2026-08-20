/**
 * The rollup must give bit-for-bit what the thirty-day scan gave.
 *
 * That claim is the entire justification for replacing the scan, and it rests
 * on every figure being decomposable across days: counts sum, levels and
 * timestamps take a max. If that is wrong for even one field, the probe report
 * silently starts judging units on different numbers than it used to — a unit
 * flipping between OK and DIED because of an arithmetic slip, not because
 * anything changed in the field.
 *
 * So this tests the merge against a reference that aggregates the same frames
 * in one pass, the way the old query did.
 */

import { describe, it, expect } from 'vitest'

interface Frame { vehicleId: string; at: Date; fuelLevelMl: number | null }

interface Figures {
  pings:       number
  levelPings:  number
  peakMl:      number | null
  lastAliveAt: Date | null
  lastLevelAt: Date | null
}

/** What the OLD query did: one aggregate over the whole window. */
function aggregateWhole(frames: Frame[]): Map<string, Figures> {
  const out = new Map<string, Figures>()
  for (const f of frames) {
    const cur = out.get(f.vehicleId) ?? {
      pings: 0, levelPings: 0, peakMl: null, lastAliveAt: null, lastLevelAt: null,
    }
    cur.pings++
    if (f.fuelLevelMl != null) {
      cur.levelPings++
      cur.peakMl = cur.peakMl == null ? f.fuelLevelMl : Math.max(cur.peakMl, f.fuelLevelMl)
      if (cur.lastLevelAt == null || f.at > cur.lastLevelAt) cur.lastLevelAt = f.at
      // ABOVE zero — a probe pinned at zero is reporting and also broken.
      if (f.fuelLevelMl > 0 && (cur.lastAliveAt == null || f.at > cur.lastAliveAt)) {
        cur.lastAliveAt = f.at
      }
    }
    out.set(f.vehicleId, cur)
  }
  return out
}

/** The merge the report performs over daily rows. Mirrors buildProbeReport. */
function mergeDays(days: Map<string, Figures>[]): Map<string, Figures> {
  const laterOf = (a: Date | null, b: Date | null): Date | null =>
    a && b ? (a > b ? a : b) : (a ?? b)
  const out = new Map<string, Figures>()
  for (const day of days) {
    for (const [id, d] of day) {
      const m = out.get(id)
      if (!m) { out.set(id, { ...d }); continue }
      m.pings      += d.pings
      m.levelPings += d.levelPings
      m.peakMl      = m.peakMl == null ? d.peakMl
                    : d.peakMl == null ? m.peakMl
                    : Math.max(m.peakMl, d.peakMl)
      m.lastAliveAt = laterOf(m.lastAliveAt, d.lastAliveAt)
      m.lastLevelAt = laterOf(m.lastLevelAt, d.lastLevelAt)
    }
  }
  return out
}

const DAY = 86_400_000
const base = Date.UTC(2026, 6, 21, 21, 0, 0) // a fleet-day boundary

function frame(vehicleId: string, dayIndex: number, hour: number, ml: number | null): Frame {
  return { vehicleId, at: new Date(base + dayIndex * DAY + hour * 3_600_000), fuelLevelMl: ml }
}

function splitByDay(frames: Frame[]): Map<string, Figures>[] {
  const buckets = new Map<number, Frame[]>()
  for (const f of frames) {
    const d = Math.floor((f.at.getTime() - base) / DAY)
    if (!buckets.has(d)) buckets.set(d, [])
    buckets.get(d)!.push(f)
  }
  return [...buckets.keys()].sort((a, b) => a - b).map(k => aggregateWhole(buckets.get(k)!))
}

describe('probe rollup equivalence', () => {
  it('reproduces a whole-window aggregate from daily rows', () => {
    const frames: Frame[] = [
      // A healthy unit reporting across three days, peak on the middle one.
      frame('a', 0, 2, 100_000), frame('a', 0, 9, 120_000),
      frame('a', 1, 3, 480_000), frame('a', 1, 15, 90_000),
      frame('a', 2, 4, 110_000),
      // A probe that died: real values, then nothing but nulls.
      frame('b', 0, 5, 200_000), frame('b', 1, 6, null), frame('b', 2, 7, null),
      // A probe pinned at zero — reporting, and broken. lastAliveAt must stay
      // on day 0 while lastLevelAt advances to day 2.
      frame('c', 0, 8, 5_000), frame('c', 1, 8, 0), frame('c', 2, 8, 0),
      // A unit that only appears on the last day.
      frame('d', 2, 11, 70_000),
    ]

    const whole  = aggregateWhole(frames)
    const merged = mergeDays(splitByDay(frames))

    expect([...merged.keys()].sort()).toEqual([...whole.keys()].sort())
    for (const [id, w] of whole) expect(merged.get(id)).toEqual(w)
  })

  it('keeps lastAliveAt behind lastLevelAt for a probe stuck at zero', () => {
    const frames = [frame('c', 0, 8, 5_000), frame('c', 1, 8, 0), frame('c', 2, 8, 0)]
    const merged = mergeDays(splitByDay(frames))!.get('c')!
    expect(merged.lastAliveAt).toEqual(new Date(base + 8 * 3_600_000))
    expect(merged.lastLevelAt).toEqual(new Date(base + 2 * DAY + 8 * 3_600_000))
    expect(merged.levelPings).toBe(3)
  })

  it('carries a null peak through a day that saw no levels at all', () => {
    // The whole point of the null-guard in the max: a day of pure nulls must
    // not drag a real peak down, and must not become a zero.
    const frames = [frame('e', 0, 1, null), frame('e', 1, 1, 300_000), frame('e', 2, 1, null)]
    const merged = mergeDays(splitByDay(frames))!.get('e')!
    expect(merged.peakMl).toBe(300_000)
    expect(merged.pings).toBe(3)
    expect(merged.levelPings).toBe(1)
    expect(merged).toEqual(aggregateWhole(frames).get('e'))
  })

  it('gives a unit with no levels a null peak, not zero', () => {
    const frames = [frame('f', 0, 1, null), frame('f', 1, 1, null)]
    const merged = mergeDays(splitByDay(frames))!.get('f')!
    expect(merged.peakMl).toBeNull()
    expect(merged.lastAliveAt).toBeNull()
    expect(merged.lastLevelAt).toBeNull()
    expect(merged.pings).toBe(2)
  })
})
