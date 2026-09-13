/**
 * The arithmetic behind "where units actually stop".
 *
 * What these pin is the claim the card makes out loud: that a busy stop is one
 * place, or that it is two. Getting the merge or the axis wrong does not throw
 * and does not look broken — it produces a confident picture of the wrong
 * thing, which is why the maths is a module of its own and why this file is
 * mostly about the split.
 */

import { describe, it, expect } from 'vitest'
import {
  M_PER_DEG, metres, mergeCells, offsetsFrom, principalAxisDeg, spreadRatio,
  projectOnto, binProfile, readSplit,
  type GridCell, type Bin,
} from '../../src/modules/analytics/stop-clusters.js'

/** A point `e` metres east and `n` metres north of an origin. */
const at = (originLat: number, originLng: number, e: number, n: number) => ({
  lat: originLat + n / M_PER_DEG,
  lng: originLng + e / M_PER_DEG,
})

const LAT = 0.3769, LNG = 34.8342

describe('metres', () => {
  it('measures a tenth of a degree as about 11 km', () => {
    expect(metres(0, 34, 0.1, 34)).toBeCloseTo(11_132, 0)
  })

  it('is symmetric and zero on itself', () => {
    expect(metres(LAT, LNG, LAT, LNG)).toBe(0)
    expect(metres(LAT, LNG, LAT + 0.001, LNG)).toBeCloseTo(metres(LAT + 0.001, LNG, LAT, LNG), 6)
  })
})

describe('mergeCells', () => {
  const cell = (e: number, n: number, fixes: number, units: number): GridCell => ({
    ...at(LAT, LNG, e, n), fixes, units,
  })

  it('joins the cells one stop was cut into', () => {
    // An 11 m grid slices a real stop wherever it straddles a boundary. Four
    // cells within a few metres of each other are one place, and the card must
    // not report it as four.
    const out = mergeCells([
      cell(0, 0, 400, 30), cell(9, 0, 300, 24), cell(0, 9, 220, 21), cell(9, 9, 180, 19),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.cells).toBe(4)
    expect(out[0]!.fixes).toBe(1100)
  })

  it('keeps two places apart when they are apart', () => {
    const out = mergeCells([cell(0, 0, 400, 30), cell(90, 0, 380, 28)])
    expect(out).toHaveLength(2)
  })

  it('takes the greatest unit count, never the sum', () => {
    // Summing would let a place made of six cells claim six times its reach:
    // the same lorry is counted in every cell it drifted across.
    const out = mergeCells([
      cell(0, 0, 400, 30), cell(8, 0, 300, 28), cell(0, 8, 200, 25),
    ])
    expect(out[0]!.units).toBe(30)
  })

  it('puts its centre where the fixes are, not between the cells', () => {
    // Weighted by fixes: a quiet cell on the edge must not drag the centre off
    // the busy one, or pass B reads a box centred on nothing.
    const out = mergeCells([cell(0, 0, 1000, 30), cell(20, 0, 10, 8)])
    const east = (out[0]!.lng - LNG) * M_PER_DEG
    expect(east).toBeGreaterThan(0)
    expect(east).toBeLessThan(1)
  })

  it('ranks by units before fixes', () => {
    // A yard one machine lives in writes more rows than a scale the whole
    // fleet crosses. The question is where the FLEET stops.
    const out = mergeCells([cell(0, 0, 9000, 9), cell(200, 0, 500, 40)])
    expect(out[0]!.units).toBe(40)
  })

  it('answers nothing for nothing', () => {
    expect(mergeCells([])).toEqual([])
  })
})

describe('principalAxisDeg', () => {
  it('finds an east-west cloud', () => {
    const pts = [-20, -10, 0, 10, 20].map(e => at(LAT, LNG, e, 0))
    const deg = principalAxisDeg(offsetsFrom({ lat: LAT, lng: LNG }, pts))
    expect(Math.abs(deg)).toBeLessThan(1)
  })

  it('finds a north-south cloud', () => {
    const pts = [-20, -10, 0, 10, 20].map(n => at(LAT, LNG, 0, n))
    const deg = principalAxisDeg(offsetsFrom({ lat: LAT, lng: LNG }, pts))
    expect(Math.abs(Math.abs(deg) - 90)).toBeLessThan(1)
  })

  it('reports a round cloud as round', () => {
    // The axis of a circle is arbitrary rather than wrong; spreadRatio is what
    // tells a reader the profile below it says little.
    const pts = [[10, 0], [-10, 0], [0, 10], [0, -10]].map(([e, n]) => at(LAT, LNG, e!, n!))
    expect(spreadRatio(offsetsFrom({ lat: LAT, lng: LNG }, pts))).toBeCloseTo(1, 1)
  })

  it('reports a line as elongated', () => {
    const pts = [-30, -15, 0, 15, 30].map(e => at(LAT, LNG, e, 0.4))
    expect(spreadRatio(offsetsFrom({ lat: LAT, lng: LNG }, pts))).toBeGreaterThan(5)
  })
})

describe('binProfile', () => {
  it('keeps the empty bins', () => {
    // A profile with its gaps dropped is a profile with no troughs in it, and
    // the trough is the whole test.
    const bins = binProfile([0, 0, 12, 12], 3)
    expect(bins.map(b => b.n)).toEqual([2, 0, 0, 0, 2])
  })

  it('is empty for no points', () => {
    expect(binProfile([])).toEqual([])
  })
})

describe('readSplit', () => {
  /** Two peaks `apart` metres apart, with `trough` counts between them. */
  const twoPeaks = (trough: number): Bin[] => [
    { at: -12, n: 10 }, { at: -9, n: 40 }, { at: -6, n: 110 }, { at: -3, n: 45 },
    { at: 0, n: trough }, { at: 3, n: 40 }, { at: 6, n: 105 }, { at: 9, n: 38 },
    { at: 12, n: 9 },
  ]

  it('reads two scales as two', () => {
    // The Kabras shape: peaks of 110 and 105 with a trough of 31 between them.
    const split = readSplit(twoPeaks(31))
    expect(split).not.toBeNull()
    expect(split!.a.n).toBe(110)
    expect(split!.b.n).toBe(105)
    expect(split!.apartM).toBe(12)
    expect(split!.dip).toBeLessThan(0.4)
  })

  it('reads a single stop as one place', () => {
    // One peak with shoulders. This is the answer most of the time, and it has
    // to come back as null rather than as a split with a bad score — the card
    // renders "one place", not "a failed attempt at two".
    const one: Bin[] = [
      { at: -12, n: 8 }, { at: -9, n: 22 }, { at: -6, n: 60 }, { at: -3, n: 104 },
      { at: 0, n: 115 }, { at: 3, n: 70 }, { at: 6, n: 26 }, { at: 9, n: 9 },
    ]
    expect(readSplit(one)).toBeNull()
  })

  it('refuses a ridge with a dent in it', () => {
    // Everything between the two ends is nearly as tall as they are. That is
    // one wide stop with a lull in the middle, not two stops — and the lull
    // has to be measured against the peaks rather than admired on its own.
    const ridge: Bin[] = [
      { at: -12, n: 10 }, { at: -9, n: 40 }, { at: -6, n: 110 }, { at: -3, n: 100 },
      { at: 0, n: 95 }, { at: 3, n: 100 }, { at: 6, n: 105 }, { at: 9, n: 38 },
      { at: 12, n: 9 },
    ]
    expect(readSplit(ridge)).toBeNull()
  })

  it('refuses a busy stop with noise beside it', () => {
    // 110 and 8 are not a pair, however clean the gap between them — and
    // neither are the two bins of 2 out at the edge, which is what this
    // originally returned: they are comparable to EACH OTHER and the dip
    // between them is perfect. A pair has to be tall against the profile, not
    // only against its partner.
    const lopsided: Bin[] = [
      { at: 0, n: 110 }, { at: 3, n: 30 }, { at: 6, n: 2 }, { at: 9, n: 1 },
      { at: 12, n: 8 }, { at: 15, n: 2 },
    ]
    expect(readSplit(lopsided)).toBeNull()
  })

  it('refuses adjacent bins of one blurred stop', () => {
    // Two neighbouring bins cannot be two places: there is no room between
    // them for a trough that means anything.
    const blurred: Bin[] = [
      { at: 0, n: 4 }, { at: 3, n: 100 }, { at: 6, n: 2 }, { at: 9, n: 98 },
      { at: 12, n: 3 },
    ]
    const split = readSplit(blurred)
    expect(split?.apartM ?? 99).toBeGreaterThanOrEqual(9)
  })

  it('says nothing about a profile too short to have a shape', () => {
    expect(readSplit([{ at: 0, n: 10 }, { at: 3, n: 2 }, { at: 6, n: 9 }])).toBeNull()
  })
})

describe('projectOnto', () => {
  it('measures along the axis it is given', () => {
    const offs = offsetsFrom({ lat: LAT, lng: LNG }, [at(LAT, LNG, 10, 0)])
    expect(projectOnto(offs, 0)[0]).toBeCloseTo(10, 3)
    expect(projectOnto(offs, 90)[0]).toBeCloseTo(0, 3)
  })
})
