import { describe, it, expect } from 'vitest'
import {
  buildPerformanceReview, reviewUnit, dailyWork, workBetween, equipmentGroup, unitRef, classify, statusOf, median,
  type ReviewDay, type ReviewFill, type ReviewVehicle,
} from '../../src/modules/fuel/fuel-performance-review.js'

// Fleet days are EAT; 06:00 EAT = 03:00Z.
const at = (day: string, hhEat = 6) => new Date(Date.parse(`${day}T00:00:00Z`) + (hhEat - 3) * 3_600_000)
const days = (keys: string[], f: (i: number) => Partial<ReviewDay>): ReviewDay[] =>
  keys.map((day, i) => ({ day, meter: null, engineSeconds: null, distanceKm: null, ...f(i) }))
const keys = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10))

const EX: ReviewVehicle = { id: 'v1', name: 'MUFINDI: EX 08', category: 'Excavator', rate: 10, basis: 'HOURS' }

describe('names and groups', () => {
  it('reads the reference off either separator', () => {
    expect(unitRef('MUFINDI: EX 08')).toBe('EX 08')
    expect(unitRef('MUFINDI - DG 12')).toBe('DG 12')
  })
  it('groups by register category, then by plate family', () => {
    expect(equipmentGroup('Bull Dozer', 'MUFINDI: DZ 02')).toBe('Bulldozers')
    expect(equipmentGroup('CASE STEIGER', 'MUFINDI - CTR 23')).toBe('CASE tractors')
    expect(equipmentGroup(null, 'MUFINDI - FTT 04')).toBe('Trucks')
    expect(equipmentGroup('DIESEL GENERATORS', 'MUFINDI - DG 12')).toBe('Diesel generators')
  })
})

describe('classification', () => {
  it('treats >5x and <0.1x as reading errors', () => {
    expect(classify(6)).toBe('implausible')
    expect(classify(0.05)).toBe('implausible')
    expect(classify(2.5)).toBe('over')
    expect(classify(1.2)).toBe('near')
    expect(classify(null)).toBe('missing')
  })
  it('red from 110%, amber above 100%', () => {
    expect(statusOf(1.1)).toBe('over')
    expect(statusOf(1.05)).toBe('slightly-over')
    expect(statusOf(0.9)).toBe('within')
    expect(statusOf(null)).toBe('unassessed')
  })
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('work', () => {
  it('uses the meter step, and engine time across a gap or a reset', () => {
    const d = days(keys(4), i => ({ meter: [100, 110, 50, null][i]!, engineSeconds: 3600 * [9, 9, 4, 3][i]! }))
    const w = dailyWork(d, 'HOURS')
    expect(w.get('2026-09-01')).toBe(9)   // no previous reading
    expect(w.get('2026-09-02')).toBe(10)  // meter step
    expect(w.get('2026-09-03')).toBe(4)   // reset: engine time
    expect(w.get('2026-09-04')).toBe(3)
  })
  it('apportions a day evenly', () => {
    const w = new Map([['2026-09-01', 24], ['2026-09-02', 24]])
    expect(workBetween(w, at('2026-09-01', 6).getTime(), at('2026-09-02', 6).getTime())).toBeCloseTo(24)
  })
})

describe('a unit', () => {
  // 10 h a day, a refill every morning. Standard 10 L/h → 100 L a day.
  const d = days(keys(12), () => ({ engineSeconds: 36_000 }))
  const fills = (l: (i: number) => number): ReviewFill[] => keys(12).map((k, i) => ({ at: at(k), litres: l(i) }))

  it('is its median refill against standard', () => {
    const u = reviewUnit(EX, fills(i => (i % 2 ? 160 : 170)), d)
    expect(u.ref).toBe('EX 08')
    expect(u.refills).toBe(12)
    expect(u.usableRefills).toBe(11)
    expect(u.ratio!).toBeCloseTo(1.6, 1)
    expect(u.status).toBe('over')
    expect(u.excessL).toBeGreaterThan(600)
  })
  it('drops reading errors from the median and the excess', () => {
    const u = reviewUnit(EX, fills(i => (i === 5 ? 5000 : 90)), d)
    expect(u.ratio!).toBeCloseTo(0.9, 2)
    expect(u.excessL).toBe(0)
  })
  it('is not judged without a standard or with too few refills', () => {
    expect(reviewUnit({ ...EX, rate: null }, fills(() => 100), d).status).toBe('unassessed')
    expect(reviewUnit(EX, fills(() => 100).slice(0, 4), d).ratio).toBeNull()
  })
  it('counts refills logged against no work', () => {
    const idle = days(keys(12), () => ({ engineSeconds: 0 }))
    expect(reviewUnit(EX, fills(() => 100), idle).nearZeroWork).toBe(11)
  })
  it('judges km/L vehicles on distance', () => {
    const truck: ReviewVehicle = { id: 't', name: 'MUFINDI - FT 08', category: 'Truck', rate: 2.5, basis: 'DISTANCE' }
    const dd = days(keys(12), () => ({ distanceKm: 250 }))   // 100 L standard a day
    expect(reviewUnit(truck, fills(() => 200), dd).ratio!).toBeCloseTo(2, 1)
  })
})

describe('the fleet', () => {
  it('totals, months, groups and records', () => {
    const k = keys(12)
    const d = days(k, () => ({ engineSeconds: 36_000 }))
    const r = buildPerformanceReview({
      from: k[0]!, to: k.at(-1)!,
      vehicles: [EX, { id: 'v2', name: 'MUFINDI: EX 09', category: 'Excavator', rate: 10, basis: 'HOURS' }],
      fills: new Map([
        ['v1', k.map(x => ({ at: at(x), litres: 160 }))],
        ['v2', k.map(x => ({ at: at(x), litres: 60 }))],
      ]),
      days: new Map([['v1', d], ['v2', d]]),
    })
    expect(r.days).toBe(12)
    expect(r.totals.litres).toBe(12 * 220)
    expect(r.totals.assessedUnits).toBe(2)
    expect(r.months).toEqual([{ month: '2026-09', days: 12, litres: 2640, perDay: 220 }])
    expect(r.groups[0]).toMatchObject({ group: 'Excavators', units: 2, worst: 'EX 08', best: 'EX 09', busiest: 'EX 08', overCount: 1 })
    expect(r.records.near + r.records.over).toBe(22)
    expect(r.units[0]!.ref).toBe('EX 08')
  })
})
