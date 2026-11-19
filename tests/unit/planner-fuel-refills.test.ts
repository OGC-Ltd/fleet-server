import { describe, it, expect } from 'vitest'
import {
  METER_REACH_MS, meterRefill, refillFigures, refillSpan, refillWindows, wallClock, type RefillReading, type RefillWindow,
} from '../../src/modules/planner/fuel-refills.js'
import type { FactoryFuel, FuelIssue, FuelPlanLine } from '../../src/modules/planner/factory-fuel.js'

// EX-17 on 19 Nov 2026: shift 1 from 06:00 EAT for 8 h, fuelled 08:31–09:07 EAT
// (05:31–06:07 UTC), 543 L issued against SIV-000027.
const line = (over: Partial<FuelPlanLine> = {}): FuelPlanLine => ({
  lineId: 'l1', taskId: 't1', planId: 'p1', planCode: 'WP-261119-ROA-2', planStatus: 'APPROVED', department: 'ROADS',
  day: '2026-11-19', machine: 'EX-17', activity: 'Excavation', workLocation: null, fuelingLocation: null, operator: null,
  operators: [], supervisor: null, shiftNo: 1, shiftStart: '06:00:00', plannedHours: 8, plannedKm: null, fullTank: true,
  litresRequested: null, needLitres: 240, requestStatus: 'APPROVED', requestId: 'r1', requestLitres: 650, issuedLitres: 543, ...over,
})
const issue = (over: Partial<FuelIssue> = {}): FuelIssue => ({
  id: 'i1', machine: 'EX-17', day: '2026-11-19', department: 'ROADS', operator: null, activity: null, minutes: 35,
  readings: { previous: null, estimated: null, physical: 4215.2 }, requestId: 'r1',
  litres: 543, done: true, at: '2026-11-19T09:07:33.754', tank: null, pump: 'Zone 4', flags: [], note: null,
  startedAt: '2026-11-19T08:31:45.901', siv: 'SIV-000027', sensor: null, ...over,
})
const fuel = (over: Partial<FactoryFuel> = {}): FactoryFuel => ({
  factory: 'MUFINDI PAPER MILLS', from: '2026-11-19', to: '2026-11-19',
  lines: [line()], issues: [issue()],
  machines: [{ reference: 'EX-17', name: 'Excavator', category: null, basis: 'HOUR', rate: 30, status: null, downReason: null, tankLitres: 650, vehicleId: 'v17', plate: null }],
  ...over,
})

const at = (utc: string) => Date.parse(`2026-11-19T${utc}Z`)
const fix = (utc: string, fuelL: number | null, engineHours: number | null, odometerKm: number | null = null): RefillReading =>
  ({ t: at(utc), lat: -8.6, lng: 35.3, speedKmh: 0, fuelMl: fuelL == null ? null : fuelL * 1000, engineHours, odometerKm })

describe('wallClock', () => {
  it("reads FactorySuite's offsetless pump time as EAT and keeps a time that has a zone", () => {
    expect(wallClock('2026-11-19T08:31:45.901')?.toISOString()).toBe('2026-11-19T05:31:45.901Z')
    expect(wallClock('2026-11-19 08:31:45')?.toISOString()).toBe('2026-11-19T05:31:45.000Z')
    expect(wallClock('2026-11-19T05:32:09Z')?.toISOString()).toBe('2026-11-19T05:32:09.000Z')
    expect(wallClock(null)).toBeNull()
    expect(wallClock('not a time')).toBeNull()
  })
})

describe('refillWindows', () => {
  it("ties each finished fuelling to its plan line's shift, by the request", () => {
    const { machine, windows } = refillWindows(fuel(), 'ex-17')
    expect(machine?.vehicleId).toBe('v17')
    expect(windows).toEqual([{
      // km even on an hour-rated excavator: the odometer is the meter (20 Nov 2026)
      issueId: 'i1', machine: 'EX-17', vehicleId: 'v17', km: true,
      fuelStart: new Date('2026-11-19T05:31:45.901Z'), fuelEnd: new Date('2026-11-19T06:07:33.754Z'),
      shift: { lineId: 'l1', start: new Date('2026-11-19T03:00:00Z'), end: new Date('2026-11-19T11:00:00Z') },
    }])
  })

  it('with no machine named, every machine, each with its own unit', () => {
    const { machine, windows } = refillWindows(fuel({ issues: [issue(), issue({ id: 'i3', machine: 'EX-02', requestId: null })] }), null)
    expect(machine).toBeNull()
    expect(windows.map(w => [w.issueId, w.machine, w.vehicleId, w.shift?.lineId ?? null])).toEqual([
      ['i1', 'EX-17', 'v17', 'l1'], ['i3', 'EX-02', null, null],
    ])
  })

  it('leaves out fuellings still running and other machines; a fuelling on no plan line has no shift', () => {
    const { windows } = refillWindows(fuel({
      issues: [issue(), issue({ id: 'i2', done: false, at: '2026-11-19T10:00:00' }), issue({ id: 'i3', machine: 'EX-02' }), issue({ id: 'i4', requestId: null })],
    }), 'EX-17')
    expect(windows.map(w => [w.issueId, w.shift?.lineId ?? null])).toEqual([['i1', 'l1'], ['i4', null]])
  })

  it('reads the odometer for a km-rated machine', () => {
    const { windows } = refillWindows(fuel({
      machines: [{ reference: 'EX-17', name: null, category: null, basis: 'KM_PER_LITRE', rate: 3, status: null, downReason: null, tankLitres: null, vehicleId: 'v17', plate: null }],
    }), 'EX-17')
    expect(windows[0]!.km).toBe(true)
  })
})

describe('refillSpan', () => {
  const w = refillWindows(fuel(), 'EX-17').windows[0]!
  it('covers the shift and the meter reach either side of the fuelling, cut at now', () => {
    expect(refillSpan(w, new Date('2026-11-20T00:00:00Z'))).toEqual({
      from: new Date('2026-11-19T03:00:00Z'), to: new Date('2026-11-19T11:00:00Z'),
    })
    expect(refillSpan(w, new Date('2026-11-19T08:00:00Z'))?.to).toEqual(new Date('2026-11-19T08:00:00Z'))
  })
  it('without a shift, the meter reach alone', () => {
    const span = refillSpan({ ...w, shift: null }, new Date('2026-11-20T00:00:00Z'))!
    expect(span.from.getTime()).toBe(w.fuelStart!.getTime() - METER_REACH_MS)
    expect(span.to.getTime()).toBe(w.fuelEnd!.getTime() + METER_REACH_MS)
  })
})

describe('refillFigures', () => {
  const w: RefillWindow = refillWindows(fuel(), 'EX-17').windows[0]!
  // The tank at 06:00 EAT, the fill seen at 08:40, then the shift worked down.
  const readings = [
    fix('03:00:00', 110, 4213.0), fix('03:05:00', 110, 4213.0), fix('03:10:00', 110, 4213.0),
    fix('04:00:00', 95, 4213.6), fix('05:30:00', 78, 4214.1),
    fix('06:10:00', 642, 4214.1), fix('07:00:00', 620, 4214.8),
    fix('10:50:00', 541, 4218.2), fix('10:55:00', 541, 4218.3), fix('10:58:00', 541, 4218.4),
  ]
  const fillings = [{ at: at('05:40:00'), verdict: 'REFILL', observedRiseMl: 564_000, filledMl: 560_000, initialFuelLevelMl: 78_000, finalFuelLevelMl: 642_000 }]

  it("gives the tracker's meter either side of the fuelling and the shift's balance", () => {
    // the hours meter, as a window not on km reads it
    const out = refillFigures({ ...w, km: false }, readings, fillings, [], new Date('2026-11-20T00:00:00Z'))
    expect(out.tracked).toBe(true)
    expect(out.meterBefore).toEqual({ value: 4214.1, at: '2026-11-19T05:30:00.000Z', unit: 'h' })
    expect(out.meterAfter).toEqual({ value: 4214.1, at: '2026-11-19T06:10:00.000Z', unit: 'h' })
    expect(out.shift).toMatchObject({
      start: '2026-11-19T03:00:00.000Z', end: '2026-11-19T11:00:00.000Z', open: false, ahead: false,
      filledL: 564, engineHours: 5.4,
    })
    // fuel-balance takes each edge as the middle of up to 7 tank readings.
    expect(out.shift!.startL).toBe(110)
    expect(out.shift!.endL).toBe(541)
    expect(out.shift!.consumedL).toBe(133)
  })

  it('runs a shift still under way to now, and measures nothing in one not yet started', () => {
    const running = refillFigures(w, readings.filter(r => r.t <= at('07:00:00')), fillings, [], new Date('2026-11-19T07:00:01Z'))
    expect(running.shift).toMatchObject({ open: true, ahead: false, end: '2026-11-19T11:00:00.000Z' })
    const ahead = refillFigures(w, [], [], [], new Date('2026-11-19T02:00:00Z'))
    expect(ahead.shift).toMatchObject({ ahead: true, consumedL: null, engineHours: null })
  })

  it('has no meter where the tracker sent none within reach of the fuelling', () => {
    const far = [fix('02:00:00', 110, 4212.0), fix('09:00:00', 541, 4219.0)]
    const out = refillFigures(w, far, [], [], new Date('2026-11-20T00:00:00Z'))
    expect(out.meterBefore).toBeNull()
    expect(out.meterAfter).toBeNull()
  })

  it('an untracked machine keeps its refill with no tracker figures', () => {
    const out = refillFigures(w, null, [], [], new Date('2026-11-20T00:00:00Z'))
    expect(out).toMatchObject({ issueId: 'i1', machine: 'EX-17', tracked: false, meterBefore: null, meterAfter: null })
    expect(out.shift).toMatchObject({ consumedL: null, engineHours: null })
  })

  it('reads the odometer in km on a km-rated machine', () => {
    const km = [fix('05:00:00', 78, 4214.1, 12_340.26), fix('06:30:00', 642, 4214.1, 12_340.31)]
    const out = refillFigures({ ...w, km: true, shift: null }, km, [], [], new Date('2026-11-20T00:00:00Z'))
    expect(out.meterBefore).toMatchObject({ value: 12_340.3, unit: 'km' })
    expect(out.meterAfter?.value).toBe(12_340.3)
  })
})

describe('meterRefill', () => {
  const w = refillWindows(fuel(), 'EX-17').windows[0]!
  it("gives the table the tracker's meter either side of the fuelling, and no shift", () => {
    const out = meterRefill(w, {
      beforeAt: new Date('2026-11-19T05:30:00Z'), before: 4214.06, afterAt: new Date('2026-11-19T06:10:00Z'), after: 4214.14,
    })
    expect(out).toEqual({
      issueId: 'i1', machine: 'EX-17', tracked: true,
      meterBefore: { value: 4214.1, at: '2026-11-19T05:30:00.000Z', unit: 'km' },
      meterAfter: { value: 4214.1, at: '2026-11-19T06:10:00.000Z', unit: 'km' },
      shift: null,
    })
  })
  it('an untracked machine, or one the query found nothing for, has no meters', () => {
    expect(meterRefill({ ...w, vehicleId: null }, null)).toMatchObject({ tracked: false, meterBefore: null, meterAfter: null })
    expect(meterRefill(w, { beforeAt: null, before: null, afterAt: new Date('2026-11-19T06:10:00Z'), after: 4214.1 }))
      .toMatchObject({ tracked: true, meterBefore: null, meterAfter: { value: 4214.1 } })
  })
})
