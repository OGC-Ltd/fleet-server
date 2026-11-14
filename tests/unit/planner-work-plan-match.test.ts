import { describe, it, expect } from 'vitest'
import { fenceForLocation, buildMapWorkPlans, foldName, needLitres, type FenceRef } from '../../src/modules/planner/work-plan-match.js'
import type { RaiFactorySuiteWorkPlanRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const fence = (id: string, name: string, isActive = true, type = 'POLYGON'): FenceRef => ({ id, name, isActive, type })

// Kasulu's fences as named in Wialon (FleetMap ZONE_PLAN_ALIAS and the 3 Nov export)
const FENCES = [
  fence('z4', 'ZONE 4'),
  fence('z4g', 'ZONE 4 GRP'),
  fence('na', 'Nursery A'),
  fence('ca', 'Commercial Area'),
  fence('fs', 'Factory site Location'),
  fence('rs', 'Reservoir site'),
  fence('lc2', 'Logistic centre2'),
  fence('l1', 'logistic 1'),
  fence('road', 'Nursery A haulage road', true, 'LINE'),
]

describe('foldName', () => {
  it('folds spelling and spacing the sheet and Wialon disagree on', () => {
    expect(foldName('Logistics Centre 2')).toBe(foldName('Logistic center2'))
    expect(foldName('​RESEVOIR')).toBe('reservoir')
  })
})

describe('fenceForLocation', () => {
  it('places the plan sheet names on the Wialon fences', () => {
    expect(fenceForLocation('Zone 4', FENCES)?.id).toBe('z4')
    expect(fenceForLocation('Nursery A', FENCES)?.id).toBe('na')
    expect(fenceForLocation('Commercial Area (1600)', FENCES)?.id).toBe('ca')
    expect(fenceForLocation('Factory Site', FENCES)?.id).toBe('fs')
    expect(fenceForLocation('Reservoir', FENCES)?.id).toBe('rs')
    expect(fenceForLocation('Logistics Centre 2', FENCES)?.id).toBe('lc2')
  })

  it('reads Zone 4 as the operators\' 2500 Ha Area where ZONE 4 itself is missing', () => {
    expect(fenceForLocation('Zone 4', [fence('big', '2500 Ha Area')])?.id).toBe('big')
  })

  it('leaves a name it cannot place unplaced rather than guessing', () => {
    expect(fenceForLocation('Zone (424 ha)', FENCES)).toBeNull()
    expect(fenceForLocation('Intake 3', FENCES)).toBeNull()
    expect(fenceForLocation('', FENCES)).toBeNull()
  })

  it('prefers an active area over an inactive one or a road', () => {
    const fences = [fence('old', 'Nursery A', false), fence('rd', 'Nursery A', true, 'LINE'), fence('new', 'Nursery A')]
    expect(fenceForLocation('Nursery A', fences)?.id).toBe('new')
  })
})

describe('buildMapWorkPlans', () => {
  const plan = (over: Partial<RaiFactorySuiteWorkPlanRow> = {}): RaiFactorySuiteWorkPlanRow => ({
    id: 'p1', factoryCode: 'MUFINDI PAPER MILLS', planCode: 'WP-261114-AGR', department: 'AGRICULTURE',
    startDate: '2026-11-14', endDate: '2026-11-14', status: 'SUBMITTED',
    lines: [
      { id: 'l1', taskId: 'T-1', machine: 'EX-01', machineName: 'Excavator', activity: 'GRP Backfilling', workLocation: 'Zone 4', shiftNo: 1, shiftStart: '06:00:00', plannedHours: 10, active: true },
      { id: 'l2', taskId: 'T-2', machine: 'T896DSZ', machineName: 'Hired Truck', activity: 'Haulage', workLocation: 'Intake 3', shiftNo: 1, shiftStart: '18:00:00', plannedHours: 8, active: true },
      { id: 'l3', taskId: 'T-3', machine: 'EX-02', activity: 'Gone', workLocation: 'Zone 4', active: false },
    ],
    ...over,
  })
  const vehicles = [{ id: 'v1', registrationPlate: 'EX 01', name: 'Excavator EX-01', equipmentReference: 'EX-01' }]

  it('joins machines to vehicles and locations to fences, and lists what it could not place', () => {
    const out = buildMapWorkPlans('2026-11-14', 'MUFINDI PAPER MILLS', [plan()], vehicles, FENCES)
    expect(out.plans).toHaveLength(1)
    const [a, b] = out.plans[0]!.lines
    expect(out.plans[0]!.lines).toHaveLength(2)          // the inactive line is dropped
    expect(a).toMatchObject({ vehicleId: 'v1', plate: 'EX 01', fenceId: 'z4' })
    expect(b).toMatchObject({ vehicleId: null, fenceId: null })
    expect(out.unplacedMachines).toEqual(['T896DSZ'])
    expect(out.locations).toEqual([
      { name: 'Intake 3', fenceId: null, fenceName: null },
      { name: 'Zone 4', fenceId: 'z4', fenceName: 'ZONE 4' },
    ])
  })

  it('times each shift in East Africa time, start plus the planned hours', () => {
    const [a, b] = buildMapWorkPlans('2026-11-14', 'M', [plan()], vehicles, FENCES).plans[0]!.lines
    expect(a!.shiftFrom).toBe('2026-11-14T03:00:00.000Z')
    expect(a!.shiftTo).toBe('2026-11-14T13:00:00.000Z')
    expect(b!.shiftTo).toBe('2026-11-14T23:00:00.000Z')   // 18:00 + 8 h = 02:00 EAT the next morning
  })

  it('keeps only the plans that cover the day asked for', () => {
    const out = buildMapWorkPlans('2026-11-14', 'M', [plan(), plan({ id: 'p2', startDate: '2026-11-13', endDate: '2026-11-13' })], vehicles, FENCES)
    expect(out.plans.map(p => p.id)).toEqual(['p1'])
  })
})

describe('buildMapWorkPlans: the plan card', () => {
  const line = { id: 'l1', taskId: 'T-261114-AGR-02', machine: 'FT-06', machineName: 'Truck', activity: 'Agriculture - Haulage (Tons)',
    workLocation: 'Nursery A', fuelingLocation: 'Logistics Centre 1', operator: 'Zuberi Justine Onesmo', supervisor: 'Joseph Amri',
    shiftNo: 1, shiftStart: '06:00:00', plannedHours: 8, plannedKm: 150, fullTank: true, expectedOutput: 30, outputUnit: 'Tons', active: true }
  const row: RaiFactorySuiteWorkPlanRow = {
    id: 'p', factoryCode: 'MUFINDI PAPER MILLS', planCode: 'WP-261114-AGR', department: 'AGRICULTURE',
    startDate: '2026-11-14', endDate: '2026-11-14', status: 'APPROVED',
    submittedBy: 'Hashim', submittedAt: '2026-11-13T13:35:12.1', reviewedBy: 'Test', reviewedAt: '2026-11-14T06:44:42.6',
    lines: [line],
  }
  const vehicles = [{ id: 'v', registrationPlate: 'T968DZY', name: 'FT-06', equipmentReference: 'FT-06', tankCapacityLitres: 380 }]
  const machines = [{ id: 'm', factoryCode: 'MUFINDI PAPER MILLS', reference: 'FT-06', consumptionBasis: 'KM_PER_LITRE', expectedConsumption: 3,
    status: 'BROKEN_DOWN', downReason: 'ELECTRICAL FAULT' }]

  it('carries what FactorySuite\'s own row shows: fuel, tank, need, flags and the plan\'s people', () => {
    const out = buildMapWorkPlans('2026-11-14', 'M', [row], vehicles, FENCES, { machines })
    expect(out.plans[0]).toMatchObject({ submittedBy: 'Hashim', submittedAt: '2026-11-13T13:35:12.1', reviewedBy: 'Test', reviewedAt: '2026-11-14T06:44:42.6' })
    expect(out.plans[0]!.lines[0]).toMatchObject({
      fuelingLocation: 'Logistics Centre 1', fullTank: true, tankLitres: 380, needLitres: 50,
      flags: ['Broken down'], downReason: 'ELECTRICAL FAULT', pump: null,
    })
  })

  it('works the need out by the hour for an hour-rated machine, and says nothing without a rate', () => {
    expect(needLitres({ plannedHours: 12, plannedKm: null }, { consumptionBasis: 'HOUR', expectedConsumption: 6.5 })).toBe(78)
    expect(needLitres({ plannedHours: 12, plannedKm: null }, { consumptionBasis: 'HOUR', expectedConsumption: null })).toBeNull()
    expect(needLitres({ plannedHours: 12, plannedKm: null }, null)).toBeNull()
  })

  it('finds the line\'s fuel request by machine, day and shift, and the pump\'s issues by request', () => {
    const requests = [
      { id: 'r1', machine: 'ft-06', planDate: '2026-11-14', shift: 1, status: 'APPROVED' },
      { id: 'r2', machine: 'FT-06', planDate: '2026-11-14', shift: 2, status: 'APPROVED' },
    ]
    const issues = [
      { id: 'i1', machine: 'FT-06', issueDate: '2026-11-14', requestId: 'r1', completed: true, quantityIssued: 120,
        fuelingStart: '2026-11-14T05:02:00', fuelingEnd: '2026-11-14T05:10:00', tank: 'Tank 1', location: 'Logistics Centre 1',
        jobMismatch: true, flagNotes: 'no GPS position was recorded' },
      { id: 'i2', machine: 'FT-06', issueDate: '2026-11-14', requestId: 'r1', completed: false, fuelingStart: '2026-11-14T05:20:00' },
      { id: 'i3', machine: 'FT-06', issueDate: '2026-11-14', requestId: 'r2', completed: true, quantityIssued: 9 },
    ]
    const out = buildMapWorkPlans('2026-11-14', 'M', [row], vehicles, FENCES, { requests, issues })
    expect(out.plans[0]!.lines[0]!.pump).toEqual({ status: 'APPROVED', issues: [
      { litres: 120, done: true, at: '2026-11-14T05:10:00', tank: 'Tank 1', pump: 'Logistics Centre 1', flags: ['Job mismatch'], note: 'no GPS position was recorded' },
      { litres: null, done: false, at: '2026-11-14T05:20:00', tank: null, pump: null, flags: [], note: null },
    ] })
  })

  it('has no pump without a request for that shift', () => {
    const requests = [{ id: 'r9', machine: 'FT-06', planDate: '2026-11-14', shift: 2, status: 'APPROVED' }]
    const out = buildMapWorkPlans('2026-11-14', 'M', [row], vehicles, FENCES, { requests })
    expect(out.plans[0]!.lines[0]!.pump).toBeNull()
  })

  it('flags nothing for an available machine', () => {
    const out = buildMapWorkPlans('2026-11-14', 'M', [row], vehicles, FENCES, { machines: [{ ...machines[0]!, status: 'AVAILABLE' }] })
    expect(out.plans[0]!.lines[0]).toMatchObject({ flags: [], downReason: null })
  })
})
