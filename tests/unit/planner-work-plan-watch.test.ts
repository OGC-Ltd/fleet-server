import { describe, it, expect, vi } from 'vitest'

// work-plan-watch imports the service (prisma, sse); planPass and watchWindow are pure.
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))
vi.mock('../../src/modules/planner/work-plans.service.js', () => ({ workPlansChanged: vi.fn() }))

import { diffWorkPlan, lineSummary } from '../../src/modules/planner/work-plan-diff.js'
import { planPass, splitWrites, watchWindow } from '../../src/modules/planner/work-plan-watch.js'
import type { RaiFactorySuiteWorkPlanLine, RaiFactorySuiteWorkPlanRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const line = (id: string, l: Partial<RaiFactorySuiteWorkPlanLine> = {}): RaiFactorySuiteWorkPlanLine => ({
  id, taskId: `T-${id}`, machine: 'EX-12', activity: 'Backfilling', shiftNo: 1, shiftStart: '08:00:00',
  plannedHours: 10, fullTank: true, litresRequested: null, operator: 'FRANK SHIDA', supervisor: 'Boniface Lucas',
  workLocation: 'Factory Site', active: true, ...l,
})
const plan = (id: string, status: string, lines: RaiFactorySuiteWorkPlanLine[], p: Partial<RaiFactorySuiteWorkPlanRow> = {}): RaiFactorySuiteWorkPlanRow => ({
  id, factoryCode: 'MUFINDI PAPER MILLS', planCode: `WP-${id}`, department: 'FACTORY',
  startDate: '2026-11-18', endDate: '2026-11-18', status, lines, ...p,
})

describe('diffWorkPlan', () => {
  it('a new plan is one plan_added', () => {
    const c = diffWorkPlan(null, plan('a', 'DRAFT', [line('1'), line('2')]))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'plan_added', planCode: 'WP-a', day: '2026-11-18', toValue: 'DRAFT, 2 lines' })
  })

  it('a cancelled plan is a status change (WP-261118-FAC, 18 Nov)', () => {
    const c = diffWorkPlan(plan('a', 'DRAFT', [line('1')]), plan('a', 'CANCELLED', [line('1')]))
    expect(c).toEqual([expect.objectContaining({ kind: 'plan_status', fromValue: 'DRAFT', toValue: 'CANCELLED', lineId: null })])
  })

  it('a line edit is one row per field, with machine and shift', () => {
    const c = diffWorkPlan(
      plan('a', 'APPROVED', [line('1')]),
      plan('a', 'APPROVED', [line('1', { plannedHours: 8, fullTank: false, litresRequested: 200 })]),
    )
    expect(c.map(x => [x.kind, x.field, x.fromValue, x.toValue])).toEqual([
      ['line_changed', 'plannedHours', '10', '8'],
      ['line_changed', 'fullTank', 'true', 'false'],
      ['line_changed', 'litresRequested', null, '200'],
    ])
    expect(c[0]).toMatchObject({ machine: 'EX-12', shiftNo: 1, taskId: 'T-1' })
  })

  it('case and spacing are not changes', () => {
    expect(diffWorkPlan(plan('a', 'APPROVED', [line('1')]), plan('a', 'approved', [line('1', { operator: ' frank  shida ' })]))).toEqual([])
  })

  it('lines added and removed carry a summary', () => {
    const c = diffWorkPlan(plan('a', 'SUBMITTED', [line('1')]), plan('a', 'SUBMITTED', [line('2', { machine: 'EX-19' })]))
    expect(c.map(x => [x.kind, x.machine])).toEqual([['line_added', 'EX-19'], ['line_removed', 'EX-12']])
    expect(c[1]!.fromValue).toBe('shift 1 08:00, 10 h, full tank, Backfilling, at Factory Site')
  })

  it('a removed plan', () => {
    expect(diffWorkPlan(plan('a', 'APPROVED', []), null)).toEqual([expect.objectContaining({ kind: 'plan_removed', fromValue: 'APPROVED' })])
  })

  it('lineSummary with litres', () => {
    expect(lineSummary(line('1', { fullTank: false, litresRequested: 60, workLocation: null }))).toBe('shift 1 08:00, 10 h, 60 L, Backfilling')
  })
})

describe('planPass', () => {
  const window = { from: '2026-11-12', to: '2026-11-22' }
  const kept = (p: RaiFactorySuiteWorkPlanRow, goneAt: Date | null = null) => ({ id: p.id, day: p.startDate, goneAt, raw: p })

  it('the first pass only takes the snapshot', () => {
    const r = planPass([plan('a', 'APPROVED', [line('1')])], [], window, false)
    expect(r).toEqual({ changes: [], gone: [] })
  })

  it('the cancel-and-replace of 18 Nov reads as a status change and a new plan', () => {
    const old = plan('fac', 'DRAFT', [line('1')])
    const r = planPass(
      [plan('fac', 'CANCELLED', [line('1')]), plan('fac3', 'APPROVED', [line('9', { fullTank: false, litresRequested: 200 })])],
      [kept(old)], window, true,
    )
    expect(r.changes.map(c => [c.kind, c.planCode])).toEqual([['plan_status', 'WP-fac'], ['plan_added', 'WP-fac3']])
    expect(r.gone).toEqual([])
  })

  it('a plan no longer returned for a day in the window is removed', () => {
    const a = plan('a', 'APPROVED', [])
    const r = planPass([plan('b', 'APPROVED', [])], [kept(a), kept(plan('b', 'APPROVED', []))], window, true)
    expect(r.gone).toEqual(['a'])
    expect(r.changes.map(c => c.kind)).toEqual(['plan_removed'])
  })

  it('an empty read is an outage, not every plan deleted', () => {
    expect(planPass([], [kept(plan('a', 'APPROVED', []))], window, true)).toEqual({ changes: [], gone: [] })
  })

  it('a plan outside the window is left alone', () => {
    const old = plan('old', 'APPROVED', [], { startDate: '2026-11-01' })
    expect(planPass([plan('b', 'APPROVED', [])], [kept(old), kept(plan('b', 'APPROVED', []))], window, true).gone).toEqual([])
  })

  it('a plan seen again after removal is restored, with what changed meanwhile', () => {
    const a = plan('a', 'SUBMITTED', [])
    const r = planPass([plan('a', 'APPROVED', [])], [kept(a, new Date())], window, true)
    expect(r.changes.map(c => c.kind)).toEqual(['plan_restored', 'plan_status'])
  })
})

describe('splitWrites', () => {
  const kept = (p: RaiFactorySuiteWorkPlanRow, goneAt: Date | null = null) => ({ id: p.id, goneAt, raw: p })

  it('an unchanged plan is only touched; new, changed and returning plans are rewritten', () => {
    const same = plan('same', 'APPROVED', [line('1')])
    const edited = plan('ed', 'APPROVED', [line('2')])
    const back = plan('back', 'APPROVED', [])
    const read = [same, plan('ed', 'APPROVED', [line('2', { plannedHours: 6 })]), back, plan('new', 'DRAFT', [])]
    const { changes } = planPass(read, [kept(same), kept(edited), kept(back, new Date())].map(k => ({ ...k, day: k.raw.startDate })), { from: '2026-11-12', to: '2026-11-22' }, true)
    const r = splitWrites(read, [kept(same), kept(edited), kept(back, new Date())], changes)
    expect(r.touch).toEqual(['same'])
    expect(r.write.map(p => p.id)).toEqual(['ed', 'back', 'new'])
  })

  it('a status that differs only in case is not a change but is still kept as read', () => {
    const r = splitWrites([plan('a', 'approved', [])], [kept(plan('a', 'APPROVED', []))], [])
    expect(r.write.map(p => p.id)).toEqual(['a'])
  })
})

describe('watchWindow', () => {
  it('7 days back to 3 ahead, in East Africa time', () => {
    // 22:30 UTC on 18 Nov is 01:30 on 19 Nov in EAT.
    expect(watchWindow(Date.parse('2026-11-18T22:30:00Z'))).toEqual({ from: '2026-11-12', to: '2026-11-22' })
  })
})
