import { describe, it, expect, vi } from 'vitest'

// work-plan-watch imports the service (prisma, sse); planPass and watchWindow are pure.
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))
vi.mock('../../src/modules/planner/work-plans.service.js', () => ({ workPlansChanged: vi.fn() }))

import { itemEdits, itemsFromPlans } from '../../src/modules/planner/work-plan-items.js'
import { itemId, planPass, watchWindow, type KeptItem } from '../../src/modules/planner/work-plan-watch.js'
import type { RaiFactorySuiteWorkPlanLine, RaiFactorySuiteWorkPlanRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const F = 'MUFINDI PAPER MILLS'
const line = (id: string, l: Partial<RaiFactorySuiteWorkPlanLine> = {}): RaiFactorySuiteWorkPlanLine => ({
  id, taskId: `T-${id}`, machine: 'EX-12', activity: 'Backfilling', shiftNo: 1, shiftStart: '08:00:00',
  plannedHours: 10, fullTank: true, litresRequested: null, operator: 'FRANK SHIDA', supervisor: 'Boniface Lucas',
  workLocation: 'Factory Site', active: true, ...l,
})
const plan = (code: string, status: string, lines: RaiFactorySuiteWorkPlanLine[], p: Partial<RaiFactorySuiteWorkPlanRow> = {}): RaiFactorySuiteWorkPlanRow => ({
  id: `id-${code}`, factoryCode: F, planCode: code, department: 'FACTORY',
  startDate: '2026-11-18', endDate: '2026-11-18', status, lines, ...p,
})
const keep = (items: ReturnType<typeof itemsFromPlans>): KeptItem[] =>
  items.map(i => ({ id: itemId(F, i), day: i.day, status: i.status, line: i.line }))
const window = { from: '2026-11-12', to: '2026-11-22' }

describe('itemsFromPlans', () => {
  it('one item per plan line, carrying its plan status', () => {
    const items = itemsFromPlans([plan('A', 'SUBMITTED', [line('1'), line('2', { machine: 'EX-19' })])])
    expect(items.map(i => [i.lineId, i.machine, i.status, i.planCode])).toEqual([['1', 'EX-12', 'SUBMITTED', 'A'], ['2', 'EX-19', 'SUBMITTED', 'A']])
  })

  it('a machine on any number of plans keeps every line (no limit)', () => {
    const plans = ['ROA', 'AGR', 'FAC', 'IRR', 'ELE'].map((d, i) =>
      plan(`WP-${d}`, i % 2 ? 'DRAFT' : 'APPROVED', [line(`L${i}`, { shiftNo: (i % 3) + 1 })], { department: d }))
    const items = itemsFromPlans(plans)
    expect(items).toHaveLength(5)
    expect(new Set(items.map(i => i.machine))).toEqual(new Set(['EX-12']))
  })

  it('the same plan line read twice is kept once', () => {
    const items = itemsFromPlans([plan('A', 'APPROVED', [line('1'), line('1')]), plan('A', 'APPROVED', [line('1')])])
    expect(items.map(i => i.lineId)).toEqual(['1'])
  })

  it('inactive lines are not items', () => {
    expect(itemsFromPlans([plan('A', 'APPROVED', [line('1', { active: false })])])).toEqual([])
  })
})

describe('itemEdits', () => {
  const base = itemsFromPlans([plan('A', 'SUBMITTED', [line('1')])])[0]!

  it('pending to approved is one status edit', () => {
    const next = itemsFromPlans([plan('A', 'APPROVED', [line('1')])])[0]!
    expect(itemEdits(base, next)).toEqual([{ field: 'status', from: 'SUBMITTED', to: 'APPROVED' }])
  })

  it('a line edit lists each field; case and spacing do not count', () => {
    const next = itemsFromPlans([plan('A', 'submitted', [line('1', { plannedHours: 8, shiftNo: 2, operator: ' frank  shida ' })])])[0]!
    expect(itemEdits(base, next)).toEqual([{ field: 'shiftNo', from: '1', to: '2' }, { field: 'plannedHours', from: '10', to: '8' }])
  })
})

describe('planPass', () => {
  it('a pending line approved is updated in place, with the status it had', () => {
    const kept = keep(itemsFromPlans([plan('A', 'SUBMITTED', [line('1')])]))
    const r = planPass(F, itemsFromPlans([plan('A', 'APPROVED', [line('1')])]), kept, window)
    expect(r.add).toEqual([])
    expect(r.update).toHaveLength(1)
    expect(r.update[0]).toMatchObject({ previousStatus: 'SUBMITTED', item: { status: 'APPROVED' } })
  })

  it('a pending line rejected is updated in place', () => {
    const kept = keep(itemsFromPlans([plan('A', 'DRAFT', [line('1')])]))
    const r = planPass(F, itemsFromPlans([plan('A', 'REJECTED', [line('1')])]), kept, window)
    expect(r.update.map(u => [u.previousStatus, u.item.status])).toEqual([['DRAFT', 'REJECTED']])
  })

  it('a line read the same is only touched', () => {
    const items = itemsFromPlans([plan('A', 'APPROVED', [line('1')])])
    expect(planPass(F, items, keep(items), window)).toMatchObject({ add: [], update: [], remove: [], touch: [`${F}|1`] })
  })

  it('a new line on another plan for the same machine is added beside it', () => {
    const kept = keep(itemsFromPlans([plan('A', 'APPROVED', [line('1')])]))
    const r = planPass(F, itemsFromPlans([plan('A', 'APPROVED', [line('1')]), plan('B', 'DRAFT', [line('2')])]), kept, window)
    expect(r.add.map(i => i.lineId)).toEqual(['2'])
    expect(r.touch).toEqual([`${F}|1`])
  })

  it('a line FactorySuite no longer has is removed; one outside the window is left', () => {
    const kept = keep(itemsFromPlans([
      plan('A', 'APPROVED', [line('1'), line('2', { machine: 'EX-19' })]),
      plan('OLD', 'APPROVED', [line('3')], { startDate: '2026-11-01', endDate: '2026-11-01' }),
    ]))
    const r = planPass(F, itemsFromPlans([plan('A', 'APPROVED', [line('1')])]), kept, window)
    expect(r.remove).toEqual([`${F}|2`])
  })

  it('an empty read is an outage, not every line deleted', () => {
    const kept = keep(itemsFromPlans([plan('A', 'APPROVED', [line('1')])]))
    expect(planPass(F, [], kept, window).remove).toEqual([])
  })
})

describe('watchWindow', () => {
  it('7 days back to 3 ahead, in East Africa time', () => {
    // 22:30 UTC on 18 Nov is 01:30 on 19 Nov in EAT.
    expect(watchWindow(Date.parse('2026-11-18T22:30:00Z'))).toEqual({ from: '2026-11-12', to: '2026-11-22' })
  })
})
