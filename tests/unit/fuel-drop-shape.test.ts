/**
 * The shape primitives, checked against curves whose answers are known.
 *
 * These exist because the thresholds in `fuel-theft-classifier` will be chosen
 * from distributions this code produces. A fitter that is subtly wrong does not
 * announce itself — it produces plausible percentiles, the thresholds are set
 * against them, and the error is baked into a live theft alert. So the fits are
 * checked against synthetic falls where the true shape is not in question.
 */

import { describe, it, expect } from 'vitest'
import {
  engineOnSeconds, engineEvidenceRatio, fitLinear, fitDecay, halfSlopeRatio,
  stepFraction, normalisedResidual,
  MAX_ENGINE_GAP_SECONDS, type ShapeSample,
} from '../../src/modules/fuel/fuel-drop-shape.js'

const T0 = new Date('2026-08-10T08:00:00Z')

/** `n` samples at `stepSec` apart, levels from `f(i)`. */
const series = (n: number, stepSec: number, f: (i: number) => number, engineOn?: boolean): ShapeSample[] =>
  Array.from({ length: n }, (_, i) => ({
    capturedAt:  new Date(T0.getTime() + i * stepSec * 1000),
    fuelLevelMl: f(i),
    ...(engineOn === undefined ? {} : { engineOn }),
  }))

describe('engineOnSeconds', () => {
  it('credits an interval to the reading that opens it', () => {
    // Three readings 60 s apart; only the FIRST has the engine on, so exactly
    // one interval (the one it opens) is credited.
    const s: ShapeSample[] = [
      { capturedAt: new Date(T0.getTime()),           fuelLevelMl: 100, engineOn: true  },
      { capturedAt: new Date(T0.getTime() + 60_000),  fuelLevelMl:  99, engineOn: false },
      { capturedAt: new Date(T0.getTime() + 120_000), fuelLevelMl:  98, engineOn: false },
    ]
    expect(engineOnSeconds(s, T0, new Date(T0.getTime() + 120_000))).toBe(60)
  })

  it('caps a long silence rather than crediting the whole gap', () => {
    // The failure this guard exists for: a unit reports, goes quiet for three
    // hours, reports again. Two readings must not yield three engine-hours.
    const s: ShapeSample[] = [
      { capturedAt: new Date(T0.getTime()),               fuelLevelMl: 100, engineOn: true },
      { capturedAt: new Date(T0.getTime() + 3 * 3600_000), fuelLevelMl:  90, engineOn: true },
    ]
    const total = engineOnSeconds(s, T0, new Date(T0.getTime() + 3 * 3600_000))
    expect(total).toBe(MAX_ENGINE_GAP_SECONDS)
  })

  it('counts nothing when no reading carries an engine state', () => {
    const s = series(10, 30, i => 100 - i)
    expect(engineOnSeconds(s, T0, new Date(T0.getTime() + 300_000))).toBe(0)
  })
})

describe('engineEvidenceRatio', () => {
  it('separates "engine was off" from "we do not know"', () => {
    // The distinction the whole siphon branch rests on: an absent engine state
    // must never read as a measured OFF.
    const known   = series(10, 30, () => 100, false)
    const unknown = series(10, 30, () => 100)
    const to = new Date(T0.getTime() + 10 * 30 * 1000)
    expect(engineEvidenceRatio(known,   T0, to)).toBe(1)
    expect(engineEvidenceRatio(unknown, T0, to)).toBe(0)
  })
})

describe('fitLinear', () => {
  it('recovers the slope of a straight fall', () => {
    // 2 ml/s down, sampled every 30 s.
    const s = series(20, 30, i => 100_000 - 60 * i)
    const f = fitLinear(s)!
    expect(f.slope).toBeCloseTo(-2, 6)
    expect(f.intercept).toBeCloseTo(100_000, 3)
    expect(f.rmse).toBeLessThan(1e-6)
  })

  it('returns null with too few points to describe a line', () => {
    expect(fitLinear(series(2, 30, i => 100 - i))).toBeNull()
  })
})

describe('fitDecay', () => {
  it('recovers a genuine settle, and reports kT above 1', () => {
    // y = 50_000 + 50_000·e^(−t/600), watched for 30 min → kT = 3.
    const s = series(60, 30, i => 50_000 + 50_000 * Math.exp(-(i * 30) / 600))
    const f = fitDecay(s)!
    expect(f.kT).toBeGreaterThan(1)
    // Within ~500 ml of the true asymptote. The scan is 60 geometric steps in
    // kT, so the recovered parameters are approximate by construction — this
    // module exists to classify a shape, not to measure a tank.
    expect(Math.abs(f.asymptote - 50_000)).toBeLessThan(500)
    expect(normalisedResidual(f, 50_000)!).toBeLessThan(0.01)
  })

  it('reports kT near zero for a straight fall — the case that must not read as a settle', () => {
    // A siphon is linear, and the decay family CONTAINS the line in its k→0
    // limit, so the fitter will happily fit it. What must hold is that it
    // reports the fall as unbent.
    const s = series(40, 30, i => 100_000 - 60 * i)
    const f = fitDecay(s)!
    expect(f.kT).toBeLessThan(0.5)
  })

  it('fits a straight line to a negligible residual, though not to zero', () => {
    // The scan's lowest kT is 0.05, not 0, so the decay family cannot reach a
    // PERFECT line and its residual on one is small but non-zero (~5 ml on a
    // 100 L fall). Asserted as a share of the drop, because that is the only
    // form in which "negligible" means anything.
    const s = series(40, 30, i => 100_000 - 60 * i)
    const dec = fitDecay(s)!
    expect(normalisedResidual(dec, 100_000 - 60 * 39)!).toBeLessThan(0.001)
  })
})

describe('halfSlopeRatio', () => {
  it('is about 1 for a steady fall', () => {
    const s = series(20, 30, i => 100_000 - 60 * i)
    expect(halfSlopeRatio(s)!).toBeCloseTo(1, 2)
  })

  it('is well below 1 for a fall that eases off', () => {
    const s = series(60, 30, i => 50_000 + 50_000 * Math.exp(-(i * 30) / 600))
    expect(halfSlopeRatio(s)!).toBeLessThan(0.4)
  })

  it('is null when the level never moved', () => {
    expect(halfSlopeRatio(series(20, 30, () => 100_000))).toBeNull()
  })
})

describe('the three shapes are distinguishable', () => {
  const line  = series(40, 30, i => 100_000 - 60 * i)
  const decay = series(40, 30, i => 50_000 + 50_000 * Math.exp(-(i * 30) / 300))
  /** A sharp siphon: flat, one interval taking 40 L, flat again. */
  const stepAt = (at: number): ShapeSample[] => series(40, 30, i => i < at ? 100_000 : 60_000)

  it('step fraction separates all three, and is the only measure that does', () => {
    expect(stepFraction(stepAt(20))).toBeGreaterThan(0.9)
    expect(stepFraction(line)).toBeLessThan(0.1)
    expect(stepFraction(decay)).toBeLessThan(0.3)
  })

  it('line vs decay: separated by kT and half-slope', () => {
    expect(fitDecay(line)!.kT).toBeLessThan(0.5)
    expect(fitDecay(decay)!.kT).toBeGreaterThan(1)
    expect(halfSlopeRatio(line)!).toBeGreaterThan(0.8)
    expect(halfSlopeRatio(decay)!).toBeLessThan(0.4)
  })

  it('HALF-SLOPE CANNOT SEE A STEP — it reads 0, exactly like a settle', () => {
    // The failure this whole test file was written to pin down. A sharp siphon
    // has no slope either side of its step, so the ratio is 0 — the same
    // reading a settling tank gives. A classifier gating on half-slope alone
    // would suppress every hard siphon on the fleet as noise.
    for (const at of [10, 20, 30]) {
      const r = halfSlopeRatio(stepAt(at))
      // Either 0 (both halves flat around the step) or null (the FIRST half is
      // flat, so there is no denominator). Neither is ≈1, which is what a
      // steady siphon gives — so on this measure a sharp siphon is
      // indistinguishable from a settle, and a late one is unmeasurable.
      expect(r == null || r < 0.01).toBe(true)
    }
    expect(halfSlopeRatio(decay)!).toBeLessThan(0.4)   // indistinguishable
  })

  it('kT CANNOT SEE A STEP EITHER — its answer depends on where the step sits', () => {
    // Measured 2026-08-16: the same event, moved within the window, swings the
    // fitted curvature across the entire scan range. Nothing about the fuel
    // changed; only when we happened to start watching.
    expect(fitDecay(stepAt(2))!.kT).toBeGreaterThan(5)     // rails high
    expect(fitDecay(stepAt(20))!.kT).toBeLessThan(0.1)     // rails low
  })

  it('the RESIDUAL is what betrays a step: neither model fits it', () => {
    // The corroborating signal. A real line and a real decay are both fitted
    // to well under 1% of their drop; a step cannot be fitted by either and
    // leaves more than 10%.
    expect(normalisedResidual(fitDecay(line)!,  40_000)!).toBeLessThan(0.01)
    expect(normalisedResidual(fitDecay(decay)!, 50_000)!).toBeLessThan(0.01)
    for (const at of [2, 20, 35]) {
      expect(normalisedResidual(fitDecay(stepAt(at))!, 40_000)!).toBeGreaterThan(0.1)
    }
  })
})
