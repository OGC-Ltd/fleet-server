import { describe, it, expect } from 'vitest'
import { buildFactoryFuel } from '../../src/modules/planner/factory-fuel.js'
import { buildFactorySupervisors, lineWindow, runKey, type LineRun } from '../../src/modules/planner/factory-supervisors.js'
import type { RaiFactorySuiteWorkPlanRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const plan = (day: string, status: string, lines: Array<Partial<NonNullable<RaiFactorySuiteWorkPlanRow['lines']>[number]>>): RaiFactorySuiteWorkPlanRow => ({
  id: `p-${day}-${status}`, factoryCode: 'MUFINDI PAPER MILLS', planCode: `WP-${day}`, department: 'IRRIGATION',
  startDate: day, endDate: day, status,
  lines: lines.map((l, n) => ({ id: `l-${day}-${status}-${n}`, taskId: `T${n}`, machine: 'EX-01', activity: 'Trench', active: true, ...l })),
})
const register = [
  { id: 'm1', factoryCode: 'MUFINDI PAPER MILLS', reference: 'EX-01', name: 'Excavator', consumptionBasis: 'HOUR', expectedConsumption: 14, status: 'AVAILABLE' },
  { id: 'm2', factoryCode: 'MUFINDI PAPER MILLS', reference: 'TR-02', name: 'Tractor', consumptionBasis: 'HOUR', expectedConsumption: 6, status: 'AVAILABLE' },
]
const units = [
  { id: 'v1', registrationPlate: 'T111AAA', equipmentReference: 'EX-01' },
  { id: 'v2', registrationPlate: 'T222BBB', equipmentReference: 'TR-02' },
]

describe('lineWindow', () => {
  it('reads the shift start as Mufindi wall clock for the planned hours', () => {
    const w = lineWindow('2026-11-13', '18:00:00', 10)!
    expect(w.start.toISOString()).toBe('2026-11-13T15:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-11-14T01:00:00.000Z')
    expect(lineWindow('2026-11-13', null, 8)!.start.toISOString()).toBe('2026-11-13T03:00:00.000Z')
    expect(lineWindow('2026-11-13', '06:00', 0)).toBeNull()
  })
})

describe('buildFactorySupervisors', () => {
  const plans = [
    plan('2026-11-13', 'APPROVED', [
      { shiftNo: 2, shiftStart: '18:00:00', plannedHours: 10, supervisor: 'Sarah Mbago', operator: 'EMMANUEL VICENT MTULO - EXCAVATOR OPERATOR' },
      { machine: 'TR-02', shiftNo: 1, shiftStart: '06:00:00', plannedHours: 8, supervisor: 'sarah  mbago', operator: 'FADHILI JUMA' },
      { machine: 'GR-09', shiftNo: 1, shiftStart: '06:00:00', plannedHours: 8, supervisor: 'Sarah Mbago' },
    ]),
    plan('2026-11-14', 'SUBMITTED', [
      { shiftNo: 1, shiftStart: '06:00:00', plannedHours: 10, supervisor: 'Lameck Amos', operator: 'EMMANUEL VICENT MTULO' },
      { machine: 'TR-02', shiftNo: 1, shiftStart: '07:00:00', plannedHours: 6, supervisor: 'Lameck Amos' },
    ]),
    plan('2026-11-14', 'DRAFT', [{ supervisor: 'Lameck Amos', plannedHours: 8, shiftStart: '06:00:00' }]),
    plan('2026-11-15', 'APPROVED', [{ shiftNo: 1, shiftStart: '06:00:00', plannedHours: 10, supervisor: 'Lameck Amos' }]),
  ]
  const fuel = buildFactoryFuel('MUFINDI PAPER MILLS', '2026-11-13', '2026-11-15', plans, [], [], register, units)
  const at = (iso: string) => new Date(iso)
  const runs = new Map<string, LineRun>([
    // EX-01 night shift: 8 of 10 hours, first worked 18:20 EAT
    [runKey('l-2026-11-13-APPROVED-0', '2026-11-13'), { samples: 900, hours: 8, firstWorkAt: at('2026-11-13T15:20:00Z') }],
    // TR-02 reported all day and never ran
    [runKey('l-2026-11-13-APPROVED-1', '2026-11-13'), { samples: 400, hours: 0.1, firstWorkAt: null }],
    // EX-01 day shift: 10 h, started 2 h late (08:00 EAT); the meter overruns the window
    [runKey('l-2026-11-14-SUBMITTED-0', '2026-11-14'), { samples: 700, hours: 12, firstWorkAt: at('2026-11-14T05:00:00Z') }],
    // TR-02 on the 14th: the tracker sent nothing
  ])
  const out = buildFactorySupervisors(fuel, runs, at('2026-11-15T10:00:00Z'))
  const by = (name: string) => out.supervisors.find(s => s.name === name)!

  it('groups lines by supervisor, folding case and spacing, and skips drafts', () => {
    expect(out.supervisors.map(s => [s.name, s.lines])).toEqual([['Lameck Amos', 3], ['Sarah Mbago', 3]])
    expect(out.skipped).toEqual({ draft: 1, cancelled: 0 })
  })

  it('judges each line against its machine\'s run', () => {
    const s = by('Sarah Mbago')
    expect(s.history.map(l => [l.machine, l.state, l.runHours])).toEqual([
      ['GR-09', 'untracked', null], ['TR-02', 'not-run', 0.1], ['EX-01', 'ran', 8],
    ])
    expect(s).toMatchObject({ judged: 2, judgedPlannedHours: 18, runHours: 8.1, deliveredPct: 45, ran: 1, notRun: 1, untracked: 1, lateStarts: 0 })
    expect(s.history.find(l => l.machine === 'EX-01')!.lateMinutes).toBe(20)
    expect(s.machines.map(m => m.reference)).toEqual(['EX-01', 'GR-09', 'TR-02'])
    expect(s.operators).toEqual(['EMMANUEL VICENT MTULO', 'FADHILI JUMA'])
  })

  it('caps the run at the window, counts late starts, and leaves silent and open lines unjudged', () => {
    const l = by('Lameck Amos')
    const states = Object.fromEntries(l.history.map(x => [`${x.day} ${x.machine}`, x.state]))
    expect(states).toEqual({ '2026-11-14 EX-01': 'ran', '2026-11-14 TR-02': 'silent', '2026-11-15 EX-01': 'open' })
    expect(l).toMatchObject({ judged: 1, runHours: 10, deliveredPct: 100, lateStarts: 1, silent: 1, open: 1 })
    expect(l.history.find(x => x.state === 'ran')!.lateMinutes).toBe(120)
  })
})
