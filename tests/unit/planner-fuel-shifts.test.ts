import { describe, it, expect } from 'vitest'
import { machineShiftUse, measureSpan, shiftUse, shiftWindows, type WindowEdges } from '../../src/modules/planner/fuel-shifts.js'
import type { FactoryFuel, FuelPlanLine } from '../../src/modules/planner/factory-fuel.js'
import type { BalanceFilling } from '../../src/modules/fuel/fuel-balance.js'

// EX-21 on 20 Nov 2026: shift 1 from 06:00 EAT for 9 h, shift 2 from 18:00
// EAT for 10 h. At 08:48 EAT (05:48 UTC) the probe read 75.3 L at the start
// of shift 1, 284.3 L went in at the pump, 352.2 L in the tank; the hours
// meter ran 2,158.606 to 2,160.073 h.
const line = (over: Partial<FuelPlanLine> = {}): FuelPlanLine => ({
  lineId: 'l1', taskId: 't1', planId: 'p1', planCode: 'WP-261120-IRR', planStatus: 'APPROVED', department: 'IRRIGATION',
  day: '2026-11-20', machine: 'EX-21', activity: 'Irrigation', workLocation: 'Zone 4', fuelingLocation: null, operator: null,
  operators: [], supervisor: null, shiftNo: 1, shiftStart: '06:00:00', plannedHours: 9, plannedKm: null, fullTank: true,
  litresRequested: null, needLitres: 126, requestStatus: 'APPROVED', requestId: 'r1', requestLitres: 400, issuedLitres: 293, ...over,
})
const machine = (reference: string, vehicleId: string | null) =>
  ({ reference, name: 'Excavator', category: null, basis: 'HOUR', rate: 14, status: null, downReason: null, tankLitres: 400, vehicleId, plate: null })
const fuel = (lines: FuelPlanLine[], machines = [machine('EX-21', 'v21')]): FactoryFuel =>
  ({ factory: 'MUFINDI PAPER MILLS', from: '2026-11-20', to: '2026-11-20', lines, issues: [], machines })

const NOW = new Date('2026-11-20T05:48:00Z')
const shift2 = line({ lineId: 'l2', planCode: 'WP-261120-IRR-2', shiftNo: 2, shiftStart: '18:00:00', plannedHours: 10, needLitres: 140 })
const level = (l: number) => Array.from({ length: 7 }, () => l * 1000)
const edges = (startL: number, endL: number, h0: number | null, h1: number | null): WindowEdges =>
  ({ first: level(startL), last: level(endL), hoursFirst: h0, hoursLast: h1, kmFirst: null, kmLast: null })
const fill = (utc: string, recordedL: number, observedL: number | null = null, verdict = 'REFILL'): BalanceFilling =>
  ({ at: Date.parse(utc), verdict, observedRiseMl: observedL == null ? null : observedL * 1000, filledMl: recordedL * 1000, initialFuelLevelMl: null, finalFuelLevelMl: null })

describe('shiftWindows', () => {
  it("gives each plan line its shift window, on the machine's unit", () => {
    expect(shiftWindows(fuel([line(), shift2]))).toEqual([
      { key: 'EX21#0', machine: 'EX-21', vehicleId: 'v21', start: new Date('2026-11-20T03:00:00Z'), end: new Date('2026-11-20T12:00:00Z'), lineIds: ['l1'] },
      { key: 'EX21#1', machine: 'EX-21', vehicleId: 'v21', start: new Date('2026-11-20T15:00:00Z'), end: new Date('2026-11-21T01:00:00Z'), lineIds: ['l2'] },
    ].map(w => ({ ...w, key: expect.stringMatching(/#[01]$/) })))
  })

  it('merges two lines that overlap, so nothing counts twice (EX-16, 20 Nov: two night lines)', () => {
    const ws = shiftWindows(fuel([
      line({ machine: 'EX-16', shiftStart: '18:00:00', plannedHours: 10 }),
      line({ lineId: 'l2', machine: 'EX-16', shiftStart: '20:00:00', plannedHours: 10 }),
    ], [machine('EX-16', 'v16')]))
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({ start: new Date('2026-11-20T15:00:00Z'), end: new Date('2026-11-21T03:00:00Z'), lineIds: ['l1', 'l2'] })
  })

  it('leaves out plans that put nobody to work, and lines with no planned hours', () => {
    const ws = shiftWindows(fuel([line({ planStatus: 'CANCELLED' }), line({ lineId: 'l3', planStatus: 'REJECTED' }), line({ lineId: 'l4', plannedHours: null })]))
    expect(ws).toEqual([])
  })

  it('a machine that is not one of our units has no vehicle', () => {
    expect(shiftWindows(fuel([line({ machine: 'DG-22' })], [machine('DG-22', null)]))[0]?.vehicleId).toBeNull()
  })
})

describe('measureSpan', () => {
  it('measures a running shift up to now, and a shift ahead not at all', () => {
    const [s1, s2] = shiftWindows(fuel([line(), shift2]))
    expect(measureSpan(s1!, NOW)).toEqual({ from: new Date('2026-11-20T03:00:00Z'), to: NOW })
    expect(measureSpan(s2!, NOW)).toBeNull()
  })
})

describe('shiftUse', () => {
  const [s1] = shiftWindows(fuel([line()]))
  it("is the tank at the shift's start plus the fills less the tank now (EX-21, 08:48 EAT)", () => {
    const u = shiftUse(s1!, edges(75.3, 352.2, 2158.606, 2160.073), [fill('2026-11-20T04:50:00Z', 284.3)], [], NOW)
    expect(u).toMatchObject({ open: true, ahead: false, startL: 75.3, endL: 352.2, filledL: 284.3, theftL: 0, usedL: 7.4, hours: 1.47 })
  })

  it("counts a fill at the litres the probe recorded, not the verifier's later rise (EX-21, 09:03 EAT: 284.3 recorded, 209.6 observed)", () => {
    const u = shiftUse(s1!, edges(75.3, 344.7, 2158.606, 2160.3), [fill('2026-11-20T05:02:45Z', 284.3, 209.6)], [], new Date('2026-11-20T06:10:00Z'))
    expect(u).toMatchObject({ filledL: 284.3, usedL: 14.9 })
  })

  it('leaves out a fill ruled fuel moving in the tank', () => {
    const u = shiftUse(s1!, edges(100, 90, 2158, 2159), [fill('2026-11-20T04:50:00Z', 30, null, 'REDISTRIBUTION')], [], NOW)
    expect(u).toMatchObject({ filledL: 0, usedL: 10 })
  })

  it('counts a fill only inside the shift', () => {
    const u = shiftUse(s1!, edges(75.3, 352.2, 2158.606, 2160.073), [fill('2026-11-20T02:00:00Z', 284.3)], [], NOW)
    expect(u.filledL).toBe(0)
  })

  it('gives no litres when the tank rose with no fill on record while the machine worked', () => {
    expect(shiftUse(s1!, edges(75.3, 352.2, 2158.606, 2160.073), [], [], NOW).usedL).toBeNull()
  })

  it('gives no hours when the meter is missing at one end or runs backwards', () => {
    expect(shiftUse(s1!, edges(100, 90, null, 2160), [], [], NOW).hours).toBeNull()
    expect(shiftUse(s1!, edges(100, 90, 2160, 2150), [], [], NOW).hours).toBeNull()
  })
})

describe('machineShiftUse', () => {
  it("adds up a machine's shifts so far, with the litres an hour", () => {
    const ws = shiftWindows(fuel([line(), shift2]))
    const [m] = machineShiftUse(ws, new Map([[ws[0]!.key, edges(75.3, 352.2, 2158.606, 2160.073)]]),
      new Map([['v21', { fillings: [fill('2026-11-20T04:50:00Z', 284.3)], drains: [] }]]), NOW)
    expect(m).toMatchObject({
      machine: 'EX-21', tracked: true, shifts: 2, measured: 1, open: true,
      usedL: 7.4, filledL: 284.3, theftL: 0, hours: 1.47, km: null, perHour: 5, kmPerL: null,
    })
    expect(m!.windows.map(w => [w.open, w.ahead])).toEqual([[true, false], [true, true]])
  })

  it('a machine that is not one of our units has its shifts counted and nothing measured', () => {
    const ws = shiftWindows(fuel([line({ machine: 'DG-22' })], [machine('DG-22', null)]))
    const [m] = machineShiftUse(ws, new Map(), new Map(), NOW)
    expect(m).toMatchObject({ machine: 'DG-22', tracked: false, shifts: 1, measured: 0, usedL: null, hours: null, perHour: null })
  })
})
