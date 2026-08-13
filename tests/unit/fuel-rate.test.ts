import { describe, it, expect } from 'vitest'
import {
  resolveRates, engineBurnMl, MIN_RUNS, MIN_GROUP_CONTRIBUTORS,
  type RateGroup, type VehicleRate,
} from '../../src/modules/fuel/fuel-rate.js'

// The guards below assume a group of MIN_GROUP_CONTRIBUTORS is usable and one
// short of it is not; if that constant moves, these fixtures must move with it.
expect(MIN_GROUP_CONTRIBUTORS).toBe(3)

const veh = (vehicleId: string, lPerHour: number, runs: number): VehicleRate =>
  ({ vehicleId, lPerHour, lPerKm: null, runs })

const grp = (vehicleId: string, vehicleType: string, organisationId = 'kasulu'): RateGroup =>
  ({ vehicleId, organisationId, vehicleType })

describe('resolveRates', () => {
  it("uses a vehicle's own rate once it has enough runs", () => {
    const out = resolveRates([veh('ex01', 9.79, MIN_RUNS)], [grp('ex01', 'PLANT')])
    expect(out.get('ex01')).toEqual({ lPerHour: 9.79, basis: 'vehicle', runs: MIN_RUNS, spread: null })
  })

  it('falls back to the org+type median below MIN_RUNS', () => {
    // The thin vehicle's own 40 L/h is ignored — one run is one haul's load and
    // one probe's afternoon — and it takes the median of its type instead.
    const rates = [
      veh('ex01', 7.00, 5), veh('ex02', 9.79, 5), veh('ex03', 12.80, 5),
      veh('ex04', 40.00, MIN_RUNS - 1),
    ]
    const groups = ['ex01', 'ex02', 'ex03', 'ex04'].map(id => grp(id, 'PLANT'))
    const out = resolveRates(rates, groups)

    expect(out.get('ex04')).toEqual({ lPerHour: 9.79, basis: 'type', runs: 3, spread: 1.8 })
    // ...and the well-measured ones are untouched by it.
    expect(out.get('ex01')!.basis).toBe('vehicle')
  })

  it('excludes thin rates from the median they would otherwise skew', () => {
    // A rate too thin to trust for one machine is too thin to be evidence about
    // twenty. Without the exclusion the median below would move to 500.
    const rates = [
      veh('t1', 3.00, 5), veh('t2', 4.00, 5), veh('t3', 5.00, 5),
      veh('t4', 500.00, 1), veh('t5', 500.00, 1),
    ]
    const groups = ['t1', 't2', 't3', 't4', 't5'].map(id => grp(id, 'TRACTOR'))
    const out = resolveRates(rates, groups)
    expect(out.get('t4')).toEqual({ lPerHour: 4, basis: 'type', runs: 3, spread: 1.7 })
  })

  it('drops a group too thin to be a group', () => {
    // Measured on prod 2026-08-14: KASULU UNSPECIFIED had TWO contributors, at
    // 4.42 and 109.89 L/h, and was serving their median — about 57 L/h — to 22
    // vehicles. The median of two numbers that disagree 25-fold estimates
    // nothing. MIN_GROUP_CONTRIBUTORS is the same bar MIN_RUNS sets for a
    // single machine, for the same reason.
    const rates  = [veh('a', 4.42, 5), veh('b', 109.89, 5)]
    const groups = ['a', 'b', 'c'].map(id => grp(id, 'PLANT'))
    const out = resolveRates(rates, groups)
    expect(out.has('c')).toBe(false)
    // The two that earned their own rates still keep them.
    expect(out.get('a')!.basis).toBe('vehicle')
  })

  it('never groups by UNSPECIFIED, which is the absence of a type', () => {
    // Grouping by UNSPECIFIED groups by ignorance: those units have nothing in
    // common but that nobody classified them. A member neither draws a median
    // nor contributes to one.
    const rates = [veh('u1', 5, 9), veh('u2', 6, 9), veh('u3', 7, 9)]
    const groups = ['u1', 'u2', 'u3', 'u4'].map(id => grp(id, 'UNSPECIFIED'))
    const out = resolveRates(rates, groups)
    expect(out.has('u4')).toBe(false)          // draws nothing
    expect(out.get('u1')!.basis).toBe('vehicle') // but keeps its own
  })

  it('does not let an unclassified unit poison a real type', () => {
    const rates = [veh('p1', 8, 9), veh('p2', 9, 9), veh('p3', 10, 9), veh('junk', 900, 9)]
    const groups = [
      grp('p1', 'PLANT'), grp('p2', 'PLANT'), grp('p3', 'PLANT'),
      grp('junk', 'UNSPECIFIED'), grp('p4', 'PLANT'),
    ]
    const out = resolveRates(rates, groups)
    expect(out.get('p4')).toEqual({ lPerHour: 9, basis: 'type', runs: 3, spread: 1.3 })
  })

  it('reports how far apart a lending group is', () => {
    // Most vehicles borrow, and groups differ in coherence: KASULU PLANT spans
    // 1.5x across 21 machines where SUKARI TRACTOR spans 6.8x across 8 standing
    // in for 481. Reported rather than rejected — that is a presentation call.
    const rates  = [veh('x1', 1, 5), veh('x2', 4, 5), veh('x3', 8, 5)]
    const groups = ['x1', 'x2', 'x3', 'x4'].map(id => grp(id, 'TRACTOR'))
    const out = resolveRates(rates, groups)
    expect(out.get('x4')!.spread).toBe(8)      // 8 / 1
    expect(out.get('x1')!.spread).toBeNull()   // own rate: question does not arise
  })

  it('takes a MEDIAN of machines, not a volume-weighted aggregate', () => {
    // fuel-consumption-rates.md: Kasulu TRACTOR aggregates to 12.47 L/h against
    // a per-vehicle median of 3.51, because a few heavy tractors dominate the
    // sum. An aggregate is right for a fleet total and wrong for "what should
    // THIS machine have burned".
    const rates = [
      veh('t1', 2.0, 5), veh('t2', 3.0, 5), veh('t3', 3.5, 5),
      veh('t4', 4.0, 5), veh('t5', 60.0, 5),      // the heavy one
    ]
    const groups = ['t1', 't2', 't3', 't4', 't5', 'new'].map(id => grp(id, 'TRACTOR'))
    const out = resolveRates(rates, groups)
    // The median, unmoved by the outlier. A mean would be 14.5.
    expect(out.get('new')).toEqual({ lPerHour: 3.5, basis: 'type', runs: 5, spread: 30 })
  })

  it('never crosses a type or an org', () => {
    // A saloon at 3.04 L/h and an excavator at 11.28 have nothing to say to
    // each other, and neither does one org's tractor to another's.
    const rates = [veh('ex01', 11.28, 5), veh('kt1', 3.51, 5)]
    const groups = [
      grp('ex01', 'PLANT'), grp('kt1', 'TRACTOR'),
      grp('sal', 'SALOON'),                        // type nobody has measured
      grp('st1', 'TRACTOR', 'sukari'),             // right type, wrong org
    ]
    const out = resolveRates(rates, groups)
    expect(out.has('sal')).toBe(false)
    expect(out.has('st1')).toBe(false)
  })

  it('gives no rate at all rather than a fleet number', () => {
    const out = resolveRates([], [grp('lonely', 'PLANT')])
    expect(out.has('lonely')).toBe(false)
  })
})

describe('engineBurnMl', () => {
  it('multiplies hours by the rate', () => {
    const rate = { lPerHour: 11.28, basis: 'vehicle' as const, runs: 5, spread: null }
    expect(engineBurnMl(3_600, rate)).toBe(11_280)
    expect(engineBurnMl(1_800, rate)).toBe(5_640)
  })

  it('is null without a rate or without engine time', () => {
    // Never zero: a zero would read as "burned nothing".
    expect(engineBurnMl(3_600, null)).toBeNull()
    expect(engineBurnMl(null, { lPerHour: 9, basis: 'type', runs: 4, spread: 2 })).toBeNull()
  })

  it('is zero only when the engine genuinely never ran', () => {
    expect(engineBurnMl(0, { lPerHour: 9, basis: 'vehicle', runs: 4, spread: null })).toBe(0)
  })
})
