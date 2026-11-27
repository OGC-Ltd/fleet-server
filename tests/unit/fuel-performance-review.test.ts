import { describe, it, expect } from 'vitest'
import {
  buildPerformanceReview, reviewUnit, meterStep, dailyWork, workBetween, equipmentGroup, unitRef, classify, statusOf, median,
  type ReviewDay, type ReviewFill, type ReviewShift, type ReviewVehicle,
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
    expect(unitRef('CIVIL - Menengai - KBY 679F')).toBe('KBY 679F')
    expect(unitRef('Menengai -KDE 121E')).toBe('KDE 121E')
    expect(unitRef('MUFINDI - FT-07')).toBe('FT-07')
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
    expect(r.coveredDays).toBe(12)
    expect(r.totals.litres).toBe(12 * 220)
    expect(r.totals.assessedUnits).toBe(2)
    expect(r.months).toEqual([{ month: '2026-09', days: 12, litres: 2640, pumpL: 0, tankL: 0, perDay: 220 }])
    expect(r.source).toBe('telemetry')
    expect(r.pumpFrom).toBeNull()
    expect(r.groups[0]).toMatchObject({ group: 'Excavators', units: 2, worst: 'EX 08', best: 'EX 09', busiest: 'EX 08', overCount: 1 })
    expect(r.records.near + r.records.over).toBe(22)
    expect(r.units[0]!.ref).toBe('EX 08')
  })
})

describe('coverage', () => {
  it('averages litres a day over the days the ledger covers', () => {
    const k = keys(10)
    const r = buildPerformanceReview({
      from: k[0]!, to: k.at(-1)!, vehicles: [EX],
      fills: new Map([['v1', k.slice(5).map(x => ({ at: at(x), litres: 100 }))]]),
      days: new Map(),
    })
    expect(r.days).toBe(10)
    expect(r.coveredDays).toBe(5)
    expect(r.totals.perDay).toBe(100)
  })
})

describe('pump issues', () => {
  // Telemetry says 10 h a day; the pump's meter says 8 h between fuellings.
  const k = keys(8)
  const d = days(k, () => ({ engineSeconds: 36_000 }))
  const pump = (i: number, over: Partial<ReviewFill> = {}): ReviewFill => ({
    at: at(k[i]!), litres: 96, source: 'pump', meterWork: 8, tankL: 90, check: 'MATCH', siv: `SIV-${i}`, ...over,
  })

  it('judges each issue on its own meter step, the first one too', () => {
    const u = reviewUnit(EX, k.map((_, i) => pump(i)), d, { withRefills: true })
    expect(u.refillRows).toHaveLength(8)
    expect(u.refillRows!.every(r => r.workFrom === 'meter' && r.work === 8)).toBe(true)
    expect(u.ratio!).toBeCloseTo(1.2, 5)   // 96 L for 8 h at 10 L/h
    expect(u.pumpL).toBe(8 * 96)
    expect(u.probeL).toBe(0)
    expect(u.tankL).toBe(8 * 90)
    expect(u.issuedWithTankL).toBe(8 * 96)
    expect(u.work).toBe(64)
  })
  it('falls back to telemetry hours where the meter step is missing or impossible', () => {
    expect(meterStep(pump(1, { meterWork: null }), pump(0), 'HOURS')).toBeNull()
    expect(meterStep(pump(1, { meterWork: -3 }), pump(0), 'HOURS')).toBeNull()
    expect(meterStep(pump(1, { meterWork: 30 }), pump(0), 'HOURS')).toBeNull()   // 30 h in one day
    expect(meterStep(pump(2, { meterWork: 30 }), pump(0), 'HOURS')).toBe(30)     // over two days
    const u = reviewUnit(EX, [pump(0, { meterWork: null }), pump(1, { meterWork: null })], d, { withRefills: true })
    expect(u.refillRows).toHaveLength(1)
    expect(u.refillRows![0]).toMatchObject({ workFrom: 'telemetry', work: 10 })
  })
  it('counts tank rise only over the issues the probe read', () => {
    const u = reviewUnit(EX, [pump(0), pump(1, { tankL: null, check: 'NO_SENSOR' })], d)
    expect(u.tankL).toBe(90)
    expect(u.issuedWithTankL).toBe(96)
  })
  it('mixes probe refills before the pump records with pump issues after', () => {
    const r = buildPerformanceReview({
      from: k[0]!, to: k.at(-1)!, vehicles: [EX],
      fills: new Map([['v1', [
        ...k.slice(0, 4).map(x => ({ at: at(x), litres: 100, source: 'probe' as const })),
        ...[4, 5, 6, 7].map(i => pump(i, i === 7 ? { check: 'MISMATCH', tankL: 60 } : {})),
      ]]]),
      days: new Map([['v1', d]]),
    })
    expect(r.source).toBe('mixed')
    expect(r.pumpFrom).toBe(k[4])
    expect(r.totals).toMatchObject({ litres: 400 + 4 * 96, pumpL: 4 * 96, probeL: 400, tankL: 330 })
    expect(r.totals.checks).toEqual({ match: 3, mismatch: 1, noSensor: 0, noReading: 0 })
    expect(r.months[0]).toMatchObject({ pumpL: 384, tankL: 330 })
  })
})

describe('planned shifts', () => {
  const shift = (day: string, hours: number | null, consumedL: number | null, why: string | null = null): ReviewShift =>
    ({ day, at: at(day).toISOString(), hours, consumedL, why, issuedL: 0 })

  it('judges a planned machine on one worked shift, fuelled or not', () => {
    const u = reviewUnit(EX, [], [], {}, [shift('2026-11-27', 8, 96)])
    expect(u.judgedOn).toBe('shifts')
    expect(u.ratio).toBeCloseTo(96 / 80)
    expect(u.status).toBe('over')
    expect(u.excessL).toBeCloseTo(16)
    expect(u.judgedL).toBe(96)
    expect(u.work).toBe(8)
  })

  it('leaves out shifts the probe could not measure, with no hours, or a reading error', () => {
    const u = reviewUnit(EX, [], [], { withRefills: true }, [
      shift('2026-11-27', 8, null, 'no-probe'), shift('2026-11-26', 8, null, 'negative'),
      shift('2026-11-25', 0, 30), shift('2026-11-24', 8, 900), shift('2026-11-23', 10, 90),
    ])
    // In day order: 23rd judged, 24th 900 L in 8 h, 25th no hours, 26th negative, 27th no probe.
    expect(u.shiftRows!.map(r => r.skip)).toEqual([null, 'implausible', 'no-hours', 'negative', 'no-probe'])
    expect(u.shifts).toBe(5)
    expect(u.judgedShifts).toBe(1)
    expect(u.noProbeShifts).toBe(2)
    expect(u.ratio).toBeCloseTo(0.9)
  })

  it('keeps km-rated units on their refills', () => {
    const truck: ReviewVehicle = { id: 't', name: 'FT 16', category: 'Truck', rate: 3, basis: 'DISTANCE' }
    const u = reviewUnit(truck, [], [], {}, [shift('2026-11-27', 8, 96)])
    expect(u.judgedOn).toBeNull()
    expect(u.shifts).toBe(0)
  })

  it('shows a planned machine with no fuel issued, and the above-standard share is of the litres judged', () => {
    const r = buildPerformanceReview({
      from: '2026-11-27', to: '2026-11-27', vehicles: [EX, { ...EX, id: 'v2', name: 'EX 09' }],
      fills: new Map([['v2', [{ at: at('2026-11-27', 9), litres: 200, source: 'pump' as const }]]]),
      days: new Map(),
      shifts: new Map([['v1', [shift('2026-11-27', 8, 120)]]]),
    })
    expect(r.units.map(u => u.id).sort()).toEqual(['v1', 'v2'])
    expect(r.totals.litres).toBe(200)
    expect(r.totals.judgedL).toBe(120)
    expect(r.totals.excessL).toBeCloseTo(40)
    expect(r.totals.excessShare).toBeCloseTo(40 / 120)
    expect(r.totals.shifts).toEqual({ worked: 1, judged: 1, noProbe: 0, noHours: 0 })
    expect(r.monthToDate).toBeNull()
  })
})
