/**
 * The operator's turbulence-corrected L/hr.
 *
 * The worked example they supplied is asserted directly, and so is the case
 * where the published algebra inverts — that one is the reason the clamp
 * exists, and a test is the only thing that stops it being "simplified" back
 * out by someone reading the formula and not the note beside it.
 */

import { describe, it, expect } from 'vitest'
import { normalisedRate } from '../../src/modules/fuel/fuel-normalised-rate.js'

/** Litres and hours to the units the trend rows are stored in. */
const ml = (l: number) => Math.round(l * 1000)
const sec = (h: number) => Math.round(h * 3600)

describe('the operator worked example — DZ 14', () => {
  it('reproduces 68 L over 5.83 engine-hours as ~11.7 L/h', () => {
    // Their arithmetic: 68 / 5.83 = 11.66. With no turbulence supplied the
    // correction is inert and this must equal the plain quotient.
    const r = normalisedRate(ml(68), null, sec(5.83))!
    expect(r.lPerHour).toBeCloseTo(11.66, 1)
    expect(r.noiseDominates).toBe(false)
  })

  it('discounts the burn as turbulence grows, and brackets it', () => {
    // 68 L consumed, 10 L of probe swing across the day.
    const r = normalisedRate(ml(68), ml(10), sec(5.83))!
    // factor = 1 - (10/68)^2 = 0.978
    expect(r.lPerHour).toBeCloseTo((68 * (1 - (10 / 68) ** 2)) / 5.83, 4)
    expect(r.minLPerHour).toBeCloseTo((68 - 10) / 5.83, 4)
    expect(r.maxLPerHour).toBeCloseTo((68 + 10) / 5.83, 4)
    expect(r.lPerHour).toBeLessThan(r.maxLPerHour)
    expect(r.lPerHour).toBeGreaterThan(r.minLPerHour)
  })
})

describe('where the published formula inverts', () => {
  it('does NOT turn a negative day into a large positive burn', () => {
    // DZ 14, 2026-08-10: consumption -7.8 L, turbulence 32.0 L.
    //
    //   (32.0 / -7.8)^2 = 16.83  →  1 - 16.83 = -15.83
    //   -7.8 * -15.83   = +123 L burned, on a day the tank ENDED HIGHER.
    //
    // The sign flips twice and the answer is confidently wrong. A day with no
    // fall has no burn to normalise, so there is no number to report.
    expect(normalisedRate(ml(-7.8), ml(32), sec(4))).toBeNull()
  })

  it('floors at zero rather than going negative when noise matches the signal', () => {
    // Turbulence equal to consumption: the factor is 0, not a negative number.
    const r = normalisedRate(ml(20), ml(20), sec(4))!
    expect(r.lPerHour).toBe(0)
    expect(r.noiseDominates).toBe(true)
  })

  it('flags, rather than hides, a day whose noise exceeds its consumption', () => {
    // The reading is not usable, and the caller has to be able to tell that
    // from a genuine zero-burn day.
    const r = normalisedRate(ml(10), ml(30), sec(4))!
    expect(r.lPerHour).toBe(0)
    expect(r.noiseDominates).toBe(true)
    // The BAND still carries the information: its low end is negative, which
    // is the honest description of a day this noisy.
    expect(r.minLPerHour).toBeLessThan(0)
  })
})

describe('inputs that cannot produce a rate', () => {
  it('needs engine time for a denominator', () => {
    expect(normalisedRate(ml(68), ml(5), null)).toBeNull()
    expect(normalisedRate(ml(68), ml(5), 0)).toBeNull()
  })

  it('needs the tank to have actually fallen', () => {
    // Three of DZ 14's last eight days are negative, so this is the ordinary
    // case on a bad probe, not an edge case.
    expect(normalisedRate(ml(-96.3), ml(27.1), sec(14.45))).toBeNull()
    expect(normalisedRate(0, ml(5), sec(4))).toBeNull()
    expect(normalisedRate(null, ml(5), sec(4))).toBeNull()
  })

  it('treats missing turbulence as no correction, not as a missing day', () => {
    // The column is null on rows written before it existed and on machines
    // with too few runs to average.
    const r = normalisedRate(ml(50), null, sec(5))!
    expect(r.lPerHour).toBeCloseTo(10, 6)
    expect(r.minLPerHour).toBeCloseTo(10, 6)
    expect(r.maxLPerHour).toBeCloseTo(10, 6)
  })
})
