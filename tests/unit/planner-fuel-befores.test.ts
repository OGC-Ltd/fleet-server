import { describe, it, expect } from 'vitest'
import { applyKept, keepRows, KEEP_SETTLE_MS } from '../../src/modules/planner/fuel-befores.js'
import type { MachineShiftUse, ShiftUse, ShiftWindow } from '../../src/modules/planner/fuel-shifts.js'

const F = 'MUFINDI PAPER MILLS'
const at = (iso: string) => new Date(iso)
// BH-01 on 24 Nov: shift 1 06:00-14:00 EAT, shift 2 14:00-22:00 EAT.
const w1: ShiftWindow = { key: 'BH01#0', machine: 'BH-01', vehicleId: 'v1', start: at('2026-11-24T03:00:00Z'), end: at('2026-11-24T11:00:00Z'), lineIds: ['l1'] }
const w2: ShiftWindow = { key: 'BH01#1', machine: 'BH-01', vehicleId: 'v1', start: at('2026-11-24T11:00:00Z'), end: at('2026-11-24T19:00:00Z'), lineIds: ['l2'] }
const use = (w: ShiftWindow, beforeL: number | null, beforeAt: string | null): ShiftUse => ({
  start: w.start.toISOString(), end: w.end.toISOString(), open: false, ahead: false, lineIds: w.lineIds,
  usedL: null, startL: null, firstTenL: null, firstTenAt: null, firstTenFrom: null,
  beforeL, beforeAt, beforeBy: beforeAt ? 'work' : null, beforeReadAt: null,
  endL: null, endAt: null, endGap: false, filledL: 0, theftL: 0, hours: null, km: null,
})
const machine = (windows: ShiftUse[]): MachineShiftUse => ({
  machine: 'BH-01', tracked: true, shifts: windows.length, measured: 0, open: false, usedL: null, filledL: 0, theftL: 0,
  hours: null, km: null, perHour: null, kmPerL: null, windows,
})
const lines = [
  { lineId: 'l1', day: '2026-11-24', machine: 'BH-01' },
  { lineId: 'l2', day: '2026-11-24', machine: 'BH-01' },
]
const measured = [machine([use(w1, 75, '2026-11-24T05:24:00.000Z'), use(w2, 60.5, '2026-11-24T11:09:00.000Z')])]

describe('Fuel before kept', () => {
  it('keeps each settled line of a past day with its shift figure', () => {
    const { rows, pending } = keepRows(F, 'org', '2026-11-24', '2026-11-25', lines, [w1, w2], measured, at('2026-11-25T01:00:00Z'))
    expect(pending).toBe(false)
    expect(rows.map(r => [r.id, r.beforeL, r.beforeAt?.toISOString(), r.beforeBy])).toEqual([
      [`${F}|l1`, 75, '2026-11-24T05:24:00.000Z', 'work'],
      [`${F}|l2`, 60.5, '2026-11-24T11:09:00.000Z', 'work'],
    ])
    expect(rows[1]!.windowStart).toEqual(w2.start)
  })

  it('leaves today, and a shift not settled yet, to the live reading', () => {
    expect(keepRows(F, 'org', '2026-11-25', '2026-11-25', lines, [w1, w2], measured, at('2026-11-25T12:00:00Z'))).toEqual({ rows: [], pending: true })
    const early = new Date(w2.end.getTime() + KEEP_SETTLE_MS - 60_000)
    const { rows, pending } = keepRows(F, 'org', '2026-11-24', '2026-11-25', lines, [w1, w2], measured, early)
    expect(pending).toBe(true)
    expect(rows.map(r => r.lineId)).toEqual(['l1'])
  })

  it('keeps a line with no shift window as measured nothing, once', () => {
    const { rows } = keepRows(F, 'org', '2026-11-24', '2026-11-25',
      [...lines, { lineId: 'l3', day: '2026-11-24', machine: 'EX-22' }, { lineId: 'l3', day: '2026-11-24', machine: 'EX-22' }],
      [w1, w2], measured, at('2026-11-25T06:00:00Z'))
    const l3 = rows.filter(r => r.lineId === 'l3')
    expect(l3).toHaveLength(1)
    expect(l3[0]).toMatchObject({ windowStart: null, beforeL: null, beforeAt: null })
  })

  it('shows the kept figure over a fresh reading for the same window', () => {
    const fresh = [machine([use(w1, 74, '2026-11-24T05:24:00.000Z'), use(w2, null, null)])]
    const kept = new Map([
      ['l1', { windowStart: w1.start, windowEnd: w1.end, beforeL: 75, beforeAt: at('2026-11-24T05:24:00Z'), beforeBy: 'work' as const, beforeReadAt: null }],
      ['l2', { windowStart: w2.start, windowEnd: w2.end, beforeL: 60.5, beforeAt: at('2026-11-24T11:09:00Z'), beforeBy: 'work' as const, beforeReadAt: null }],
    ])
    const out = applyKept(fresh, kept)[0]!.windows
    expect(out.map(u => [u.beforeL, u.beforeKept])).toEqual([[75, true], [60.5, true]])
  })

  it('ignores a kept figure for a window that has since moved', () => {
    const kept = new Map([['l1', { windowStart: at('2026-11-24T04:00:00Z'), windowEnd: w1.end, beforeL: 99, beforeAt: null, beforeBy: null, beforeReadAt: null }]])
    const out = applyKept(measured, kept)[0]!.windows
    expect(out[0]!.beforeL).toBe(75)
    expect(out[0]!.beforeKept).toBeUndefined()
  })
})
