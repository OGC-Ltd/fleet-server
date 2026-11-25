import { describe, it, expect } from 'vitest'
import { placeFuelling, shiftConsumed, withShiftFuel } from '../../src/modules/planner/shift-fuel.js'
import type { MachineShiftUse, ShiftUse } from '../../src/modules/planner/fuel-shifts.js'
import type { FactoryFuel } from '../../src/modules/planner/factory-fuel.js'

// EX-17 on 23 Nov: shift 1 06:00-14:00 EAT, shift 2 14:00-22:00 EAT; one
// fuelling, 576 L at 16:09 EAT on shift 1's request.
const use = (start: string, end: string, o: Partial<ShiftUse>): ShiftUse => ({
  start, end, open: false, ahead: false, lineIds: [], usedL: null, startL: null, firstTenL: null, firstTenAt: null, firstTenFrom: null,
  beforeL: null, beforeAt: null, beforeBy: null, beforeReadAt: null, endL: null, endAt: end, endGap: false, filledL: 0, theftL: 0, hours: null, km: null, ...o,
})
const s1 = use('2026-11-23T03:00:00.000Z', '2026-11-23T11:00:00.000Z', { lineIds: ['l1'], beforeL: 194.4, beforeAt: '2026-11-23T03:34:00.000Z', beforeBy: 'work', endL: 52, hours: 7.6 })
const s2 = use('2026-11-23T11:00:00.000Z', '2026-11-23T19:00:00.000Z', { lineIds: ['l2'], beforeL: 52.4, beforeAt: '2026-11-23T11:00:00.000Z', beforeBy: 'work', endL: 619, hours: 6.2 })
const machine = (windows: ShiftUse[]): MachineShiftUse => ({ machine: 'EX-17', tracked: true, shifts: windows.length, measured: 0, open: false, usedL: null, filledL: 0, theftL: 0, hours: null, km: null, perHour: null, kmPerL: null, windows })
const issue = (id: string, startedAt: string, litres: number) => ({ id, machine: 'EX-17', day: startedAt.slice(0, 10), done: true, litres, at: startedAt, startedAt, siv: `SIV-${id}` })
const fuel = (issues: ReturnType<typeof issue>[]) => ({
  issues, machines: [{ reference: 'EX-17', basis: 'HOUR', rate: 30 }],
}) as unknown as Pick<FactoryFuel, 'issues' | 'machines'>

describe('shift fuel', () => {
  it('puts a fuelling on the shift it happened in, with its probe filled, and works each shift out', () => {
    const [m] = withShiftFuel([machine([s1, s2])], fuel([issue('a', '2026-11-23T16:09:00', 576)]), new Map([['a', { beforeL: 53.3, afterL: 632.5, filledL: 579.2, beforeAt: null, afterAt: null, fallback: false }]]))
    const [w1, w2] = m!.windows
    expect(w1).toMatchObject({ issuedL: 0, fuellings: [], probeFilledL: null, shiftStartL: 194.4, shiftStartBy: 'before', consumedL: 142.4, probeUsedL: 228, run: 7.6, runUnit: 'h' })
    expect(w2).toMatchObject({ issuedL: 576, probeFilledL: 579.2, consumedL: 9.4, probeUsedL: 186 })
    expect(w2!.fuellings).toEqual([{ issueId: 'a', siv: 'SIV-a', litres: 576, at: '2026-11-23T13:09:00.000Z', probeFilledL: 579.2 }])
  })

  it('before the first shift goes to the next that day, after the last to the last, another day to none', () => {
    const spans = [{ from: Date.parse(s1.start), to: Date.parse(s1.end) }, { from: Date.parse(s2.start), to: Date.parse(s2.end) }]
    expect(placeFuelling(spans, Date.parse('2026-11-23T02:20:00Z'))).toBe(0)
    expect(placeFuelling(spans, Date.parse('2026-11-23T11:30:00Z'))).toBe(1)
    expect(placeFuelling(spans, Date.parse('2026-11-23T20:10:00Z'))).toBe(1)
    expect(placeFuelling(spans, Date.parse('2026-11-24T06:00:00Z'))).toBe(-1)
    expect(placeFuelling(spans, null)).toBe(-1)
  })

  it('starts a shift before its refill, and gives no consumed below nothing or without readings', () => {
    expect(shiftConsumed({ ...s2, beforeBy: 'refill' }, 576)).toMatchObject({ shiftStartBy: 'refill', consumedL: 9.4 })
    expect(shiftConsumed(s2, 0)).toMatchObject({ consumedL: null, consumedWhy: 'negative' })
    expect(shiftConsumed({ ...s2, endL: null }, 0)).toMatchObject({ consumedL: null, consumedWhy: 'no-probe' })
    expect(shiftConsumed({ ...s1, beforeL: null, firstTenL: 191.8, firstTenAt: '2026-11-23T03:44:00.000Z' }, 0)).toMatchObject({ shiftStartL: 191.8, shiftStartBy: 'first-ten', consumedL: 139.8 })
  })

  it('uses km at km/L on a km-rated machine', () => {
    const f = { issues: [], machines: [{ reference: 'EX-17', basis: 'KM_PER_LITRE', rate: 2.5 }] } as unknown as Pick<FactoryFuel, 'issues' | 'machines'>
    const [m] = withShiftFuel([machine([{ ...s1, km: 5 }])], f, new Map())
    expect(m!.windows[0]).toMatchObject({ run: 5, runUnit: 'km', probeUsedL: 2 })
  })
})
