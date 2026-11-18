import { describe, it, expect } from 'vitest'
import { buildFactoryFuel } from '../../src/modules/planner/factory-fuel.js'
import { buildFactoryOperators, splitOperator } from '../../src/modules/planner/factory-operators.js'
import type { RaiFactorySuiteWorkPlanRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const plan = (day: string, lines: Array<Partial<NonNullable<RaiFactorySuiteWorkPlanRow['lines']>[number]>>): RaiFactorySuiteWorkPlanRow => ({
  id: `p-${day}`, factoryCode: 'MUFINDI PAPER MILLS', planCode: `WP-${day}-IRR`, department: 'IRRIGATION',
  startDate: day, endDate: day, status: 'APPROVED',
  lines: lines.map((l, n) => ({ id: `l-${day}-${n}`, taskId: `T-${day}-${n}`, machine: 'EX-01', activity: 'Trench', active: true, ...l })),
})
const register = [{ id: 'm1', factoryCode: 'MUFINDI PAPER MILLS', reference: 'EX-01', name: 'Excavator', consumptionBasis: 'HOUR', expectedConsumption: 14, status: 'AVAILABLE' }]
const units = [{ id: 'v1', registrationPlate: 'T111AAA', equipmentReference: 'EX-01', tankCapacityLitres: 400 }]

describe('splitOperator', () => {
  it('splits the role the plan writes after the name', () => {
    expect(splitOperator('EMMANUEL VICENT MTULO - EXCAVATOR OPERATOR')).toEqual({ name: 'EMMANUEL VICENT MTULO', role: 'EXCAVATOR OPERATOR' })
    expect(splitOperator('  FADHILI   JUMA ')).toEqual({ name: 'FADHILI JUMA', role: null })
    expect(splitOperator('KIM-LEE OTIENO')).toEqual({ name: 'KIM-LEE OTIENO', role: null })
    expect(splitOperator('')).toBeNull()
    expect(splitOperator('N/A')).toBeNull()
  })
})

describe('buildFactoryOperators', () => {
  const plans = [
    plan('2026-11-13', [{ shiftNo: 2, shiftStart: '18:00:00', plannedHours: 10, workLocation: 'Zone 4', supervisor: 'Sarah Mbago',
      operator: 'EMMANUEL VICENT MTULO - EXCAVATOR OPERATOR', secondOperator: 'FADHILI JUMA' }]),
    plan('2026-11-14', [
      { shiftNo: 1, plannedHours: 8, operator: 'Emmanuel Vicent Mtulo - EXCAVATOR OPERATOR' },
      { machine: 'WL-02', shiftNo: 1, plannedHours: 6, operator: 'FADHILI JUMA', secondOperator: 'FADHILI JUMA' },
    ]),
  ]
  const issues = [
    { id: 'i1', machine: 'EX-01', issueDate: '2026-11-14', completed: true, quantityIssued: 120, operator: 'EMMANUEL VICENT MTULO', operatorMismatch: true },
    { id: 'i2', machine: 'GR-04', issueDate: '2026-11-14', completed: true, quantityIssued: 40, operator: 'JOHN PUMPED' },
  ]
  const fuel = buildFactoryFuel('MUFINDI PAPER MILLS', '2026-11-13', '2026-11-14', plans, [], issues, register, units)
  const out = buildFactoryOperators(fuel)

  it('lists every operator the plans and the pump name, busiest first', () => {
    expect(out.operators.map(o => [o.name, o.shifts])).toEqual([
      ['EMMANUEL VICENT MTULO - EXCAVATOR OPERATOR'.split(' - ')[0], 2],
      ['FADHILI JUMA', 2],
      ['JOHN PUMPED', 0],
    ])
  })

  it('folds case and keeps the role, machines, hours and supervisors', () => {
    const e = out.operators[0]
    expect(e).toMatchObject({
      role: 'EXCAVATOR OPERATOR', days: 2, firstDay: '2026-11-13', lastDay: '2026-11-14',
      plannedHours: 18, departments: ['IRRIGATION'], supervisors: ['Sarah Mbago'], mismatches: 1,
    })
    expect(e.machines).toEqual([{ reference: 'EX-01', name: 'Excavator', plate: 'T111AAA', vehicleId: 'v1', shifts: 2 }])
    expect(e.lines[1]).toMatchObject({ day: '2026-11-13', seat: 1, workLocation: 'Zone 4', shiftStart: '18:00:00' })
    expect(e.fuellings.map(f => f.id)).toEqual(['i1'])
  })

  it('counts a second-seat operator once per line', () => {
    const f = out.operators.find(o => o.name === 'FADHILI JUMA')!
    expect(f.lines.map(l => [l.machine, l.seat])).toEqual([['WL-02', 1], ['EX-01', 2]])
    expect(f.machines.map(m => m.reference)).toEqual(['EX-01', 'WL-02'])
  })
})
