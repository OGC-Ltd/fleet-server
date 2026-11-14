import { describe, it, expect } from 'vitest'
import { buildFactoryFuel } from '../../src/modules/planner/factory-fuel.js'
import type { RaiFactorySuiteWorkPlanRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const plan = (day: string, lines: Array<Partial<NonNullable<RaiFactorySuiteWorkPlanRow['lines']>[number]>>): RaiFactorySuiteWorkPlanRow => ({
  id: `p-${day}`, factoryCode: 'MUFINDI PAPER MILLS', planCode: `WP-${day}-AGR`, department: 'AGRICULTURE',
  startDate: day, endDate: day, status: 'APPROVED',
  lines: lines.map((l, n) => ({ id: `l-${day}-${n}`, taskId: `T-${day}-${n}`, machine: 'FT-06', activity: 'Haulage', active: true, ...l })),
})

const register = [
  { id: 'm1', factoryCode: 'MUFINDI PAPER MILLS', reference: 'FT-06', name: 'Truck', consumptionBasis: 'KM_PER_LITRE', expectedConsumption: 3, status: 'BROKEN_DOWN', downReason: 'ELECTRICAL FAULT' },
  { id: 'm2', factoryCode: 'MUFINDI PAPER MILLS', reference: 'EX-01', name: 'Excavator', consumptionBasis: 'HOUR', expectedConsumption: 6.5, status: 'AVAILABLE' },
]
const units = [{ id: 'v1', registrationPlate: 'T968DZY', equipmentReference: 'ft-06', tankCapacityLitres: 380 }]

describe('buildFactoryFuel', () => {
  it('lists each plan line in the range with its request and what the pump issued', () => {
    const plans = [
      plan('2026-11-13', [{ shiftNo: 1, plannedKm: 150, fullTank: true }, { machine: 'EX-01', shiftNo: 1, plannedHours: 12, litresRequested: 80, fullTank: false }]),
      plan('2026-11-14', [{ shiftNo: 1, plannedKm: 90, fullTank: false, litresRequested: 30 }, { shiftNo: 2, active: false }]),
      plan('2026-11-20', [{ shiftNo: 1 }]),
    ]
    const requests = [{ id: 'r1', machine: 'FT-06', planDate: '2026-11-13', shift: 1, status: 'APPROVED' }]
    const issues = [
      { id: 'i1', machine: 'FT-06', issueDate: '2026-11-13', requestId: 'r1', completed: true, quantityIssued: 100, fuelingEnd: '2026-11-13T05:34:00', operatorMismatch: true },
      { id: 'i2', machine: 'FT-06', issueDate: '2026-11-13', requestId: 'r1', completed: true, quantityIssued: 20, fuelingEnd: '2026-11-13T06:00:00' },
      { id: 'i3', machine: 'GR-04', issueDate: '2026-11-14', completed: true, quantityIssued: 50 },
    ]
    const out = buildFactoryFuel('MUFINDI PAPER MILLS', '2026-11-13', '2026-11-14', plans, requests, issues, register, units)

    expect(out.lines.map(l => [l.day, l.machine, l.shiftNo])).toEqual([
      ['2026-11-14', 'FT-06', 1], ['2026-11-13', 'EX-01', 1], ['2026-11-13', 'FT-06', 1],
    ])
    expect(out.lines[2]).toMatchObject({ fullTank: true, litresRequested: null, needLitres: 50, requestStatus: 'APPROVED', requestId: 'r1', issuedLitres: 120 })
    expect(out.lines[1]).toMatchObject({ litresRequested: 80, needLitres: 78, requestStatus: null, issuedLitres: 0 })

    expect(out.issues.map(i => i.id)).toEqual(['i3', 'i2', 'i1'])
    expect(out.issues[2]).toMatchObject({ litres: 100, done: true, flags: ['Operator mismatch'], day: '2026-11-13' })

    expect(out.machines).toEqual([
      { reference: 'EX-01', name: 'Excavator', category: null, basis: 'HOUR', rate: 6.5, status: null, downReason: null, tankLitres: null, vehicleId: null, plate: null },
      { reference: 'FT-06', name: 'Truck', category: null, basis: 'KM_PER_LITRE', rate: 3, status: 'BROKEN_DOWN', downReason: 'ELECTRICAL FAULT', tankLitres: 380, vehicleId: 'v1', plate: 'T968DZY' },
      { reference: 'GR-04', name: null, category: null, basis: null, rate: null, status: null, downReason: null, tankLitres: null, vehicleId: null, plate: null },
    ])
  })
})
