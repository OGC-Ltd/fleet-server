import { describe, it, expect } from 'vitest'
import { foldName } from '../../src/modules/planner/work-plan-match.js'
import { buildFactoryFuel, type FactoryFuel, type FuelIssue, type FuelPlanLine, type FuelVehicleRequest } from '../../src/modules/planner/factory-fuel.js'
import { buildFuellingPlan, fuellingLead, fuellingStatus } from '../../src/modules/planner/fuelling-plan.js'
import { renderFuellingPlanPdf } from '../../src/modules/planner/fuelling-plan.pdf.js'

const DAY = '2026-11-25'
const line = (machine: string, over: Partial<FuelPlanLine> = {}): FuelPlanLine => ({
  lineId: `l-${machine}-${over.shiftNo ?? 1}`, taskId: 't', planId: 'p', planCode: 'WP-261125-CIV', planStatus: 'APPROVED', department: 'CIVIL',
  day: DAY, machine, activity: 'Haulage', workLocation: 'Zone 4', fuelingLocation: 'Zone 4', operator: null, operators: [], supervisor: null,
  shiftNo: 1, shiftStart: '06:00:00', plannedHours: 8, plannedKm: null, fullTank: false, litresRequested: 100, needLitres: null,
  requestStatus: 'APPROVED', requestId: null, requestLitres: null, issuedLitres: 0, ...over,
})
const issue = (machine: string, litres: number, over: Partial<FuelIssue> = {}): FuelIssue => ({
  id: `i-${machine}-${litres}`, machine, day: DAY, department: 'CIVIL', operator: null, activity: null, minutes: 5,
  readings: { previous: null, estimated: null, physical: null }, requestId: null, startedAt: null, siv: null, sensor: null,
  litres, done: true, at: `${DAY}T08:00:00`, tank: null, pump: 'Logistics Centre 1', flags: [], note: null, ...over,
})
const request = (machine: string, over: Partial<FuelVehicleRequest> = {}): FuelVehicleRequest => ({
  requestId: `r-${machine}`, day: DAY, machine, department: 'TRANSPORT', shiftNo: 1, status: 'APPROVED', fullTank: false, litresRequested: 90, issuedLitres: 0, ...over,
})
const fuel = (over: Partial<FactoryFuel>): FactoryFuel => ({
  factory: 'MUFINDI PAPER MILLS', from: DAY, to: DAY, lines: [], issues: [], vehicleRequests: [],
  machines: [
    { reference: 'EX-28', name: 'Excavator', category: 'Excavator', basis: 'HOUR', rate: 30, status: null, downReason: null, tankLitres: 800, vehicleId: null, plate: null },
    { reference: 'DG-12', name: 'Generator', category: 'DIESEL GENERATORS', basis: 'HOUR', rate: 10, status: null, downReason: null, tankLitres: 800, vehicleId: null, plate: null },
  ],
  ...over,
})
const AFTER = Date.parse('2026-11-26T08:00:00Z')

describe('fuellingStatus', () => {
  it('reads within 10% as planned, beyond it short or over, and an open fuelling first', () => {
    expect(fuellingStatus(90, 86, false)).toBe('As planned')
    expect(fuellingStatus(24, 25, false)).toBe('As planned')
    expect(fuellingStatus(800, 85, false)).toBe('Short')
    expect(fuellingStatus(100, 120, false)).toBe('Over')
    expect(fuellingStatus(100, 0, false)).toBe('Not fuelled')
    expect(fuellingStatus(null, 183, false)).toBe('As planned')
    expect(fuellingStatus(100, 40, true)).toBe('Fuelling now')
  })
})

describe('buildFuellingPlan', () => {
  it("counts a day's approved plan lines and vehicle requests against the pumps, a machine on two shifts once", () => {
    const plan = buildFuellingPlan(fuel({
      lines: [
        line('EX-28', { litresRequested: 400 }),
        line('EX-28', { shiftNo: 2, litresRequested: 400 }),
        line('DG-12', { fuelingLocation: 'Nursery B', litresRequested: 800 }),
        line('FES130', { fullTank: true, litresRequested: null, fuelingLocation: 'Logistics Centre 2' }),
        line('CTR-08', { planStatus: 'DRAFT' }),
        line('CTR-03', { requestStatus: 'PENDING' }),
        line('DG-03', { requestStatus: 'REJECTED' }),
        line('EX-17', { day: '2026-11-24' }),
      ],
      vehicleRequests: [request('T779EQV'), request('KSPBUS-02'), request('T999XX', { status: 'CANCELLED' })],
      issues: [
        issue('EX-28', 85), issue('DG-12', 800), issue('T779EQV', 86),
        issue('GR-04', 50, { pump: 'Factory Site' }), issue('EX-17', 70, { day: '2026-11-24' }),
      ],
    }), DAY, AFTER, new Map([[foldName('KSPBUS-02'), 'Logistics Centre 1']]))

    expect(plan.closed).toBe(true)
    expect(plan.pendingLines).toBe(2)
    expect(plan.rejectedLines).toBe(1)
    expect(plan.machines.map(m => [m.machine, m.status, m.plannedL, m.fuelledL, m.diffL])).toEqual([
      ['EX-28', 'Short', 800, 85, -715],
      ['KSPBUS-02', 'Not fuelled', 90, 0, -90],
      ['FES130', 'Not fuelled', null, 0, null],
      ['T779EQV', 'As planned', 90, 86, -4],
      ['DG-12', 'As planned', 800, 800, 0],
    ])
    expect(plan.machines.find(m => m.machine === 'T779EQV')).toMatchObject({ request: true, site: 'Logistics Centre 1', department: 'TRANSPORT', type: null })
    expect(plan.machines.find(m => m.machine === 'FES130')).toMatchObject({ fullTank: true })
    expect(plan.offPlan).toEqual([{ machine: 'GR-04', type: null, site: 'Factory Site', department: 'CIVIL', fuelledL: 50, fuellings: 1 }])
    expect(plan.totals).toMatchObject({
      planned: 5, fuelled: 3, notFuelled: 2, short: 1, asPlanned: 2, over: 0, fullTankWaiting: 1, fullTanks: 1,
      plannedL: 1780, fuelledL: 971, fuelledOnFiguresL: 971, shortfallL: 715, offPlanL: 50,
    })
    expect(plan.bySite.map(g => [g.name, g.fuelled, g.planned])).toEqual([
      ['Logistics Centre 1', 1, 2], ['Nursery B', 1, 1], ['Zone 4', 1, 1], ['Logistics Centre 2', 0, 1],
    ])
    expect(plan.byType.map(g => [g.name, g.fuelledL, g.plannedL])).toEqual([
      ['DIESEL GENERATORS', 800, 800], ['Excavator', 85, 800], ['Unspecified', 86, 180],
    ])
    expect(fuellingLead(plan)).toBe('3 of the 5 planned machines were fuelled, and they received 971 litres against 1,780 litres planned. Logistics Centre 1 has the most machines still not fuelled (1).')
  })

  it('a full tank takes its request litres as its plan, and an open fuelling reads Fuelling now', () => {
    const plan = buildFuellingPlan(fuel({
      lines: [line('EX-17', { fullTank: true, litresRequested: null, requestLitres: 650 })],
      issues: [issue('EX-17', 0, { done: false })],
    }), DAY, Date.parse(`${DAY}T08:00:00Z`))
    expect(plan.closed).toBe(false)
    expect(plan.machines[0]).toMatchObject({ plannedL: 650, fullTank: false, status: 'Fuelling now', fuelledL: 0 })
    expect(fuellingLead(plan)).toBe('None of the 1 planned machine has been fuelled so far; 650 litres were planned. Zone 4 has the most machines still waiting (1).')
  })

  it('keeps the requests no plan line asked for apart from the Fuel page lines', () => {
    const plans = [{
      id: 'p', factoryCode: 'MUFINDI PAPER MILLS', planCode: 'WP', department: 'CIVIL', startDate: DAY, endDate: DAY, status: 'APPROVED',
      lines: [{ id: 'l1', taskId: 't1', machine: 'EX-28', activity: 'Dig', active: true, shiftNo: 1, litresRequested: 400 }],
    }]
    const requests = [
      { id: 'r1', machine: 'EX-28', planDate: DAY, shift: 1, status: 'APPROVED', litresRequested: 400 },
      { id: 'r2', machine: 'KSPBUS-02', department: 'TRANSPORT', planDate: DAY, shift: 1, status: 'APPROVED', litresRequested: 90 },
    ]
    const issues = [{ id: 'i1', machine: 'KSPBUS-02', issueDate: DAY, requestId: 'r2', completed: true, quantityIssued: 88 }]
    // A rejected request and an approved one for the same machine-shift: the approved one stands (DG-03, 25 Nov)
    requests.push({ id: 'r0', machine: 'EX-28', planDate: DAY, shift: 1, status: 'REJECTED', litresRequested: 300 })
    const out = buildFactoryFuel('MUFINDI PAPER MILLS', DAY, DAY, plans, requests, issues, [], [])
    expect(out.lines.map(l => [l.machine, l.requestId, l.requestStatus])).toEqual([['EX-28', 'r1', 'APPROVED']])
    expect(out.vehicleRequests).toEqual([{ requestId: 'r2', day: DAY, machine: 'KSPBUS-02', department: 'TRANSPORT', shiftNo: 1, status: 'APPROVED', fullTank: false, litresRequested: 90, issuedLitres: 88 }])
    expect(out.machines.map(m => m.reference)).toEqual(['EX-28', 'KSPBUS-02'])
  })
})

describe('renderFuellingPlanPdf', () => {
  it('draws a long day over several pages', async () => {
    const lines = Array.from({ length: 140 }, (_, n) => line(`EX-${n}`, { fuelingLocation: `Site ${n % 12}`, litresRequested: 100 + n }))
    const issues = lines.filter((_, n) => n % 3 === 0).map((l, n) => issue(l.machine, 50 + n))
    const plan = buildFuellingPlan(fuel({ lines, issues }), DAY, AFTER)
    const pdf = await renderFuellingPlanPdf(plan, { factoryName: 'Mufindi Paper Mills', orgName: 'Kasulu', now: AFTER })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length
    expect(pages).toBeGreaterThan(3)
  })
})
