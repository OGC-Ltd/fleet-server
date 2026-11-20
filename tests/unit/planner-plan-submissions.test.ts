import { describe, it, expect } from 'vitest'
import { buildPlanSubmissions, cellState } from '../../src/modules/planner/plan-submissions.js'
import type { RaiFactorySuiteWorkPlanRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const F = 'MUFINDI PAPER MILLS'
let n = 0
const plan = (department: string, day: string, status: string, submittedAt: string | null = null): RaiFactorySuiteWorkPlanRow => ({
  id: `p${++n}`, factoryCode: F, planCode: `WP-${day}-${department.slice(0, 3)}-${n}`, department,
  startDate: day, endDate: day, status, submittedAt, reviewedAt: status === 'APPROVED' ? `${day}T06:00:00` : null,
})

// Real plans from FactorySuite, 13–20 Nov 2026, against FactorySuite's own board.
describe('cellState', () => {
  it('approved and sent before 16:00 the day before is on time', () => {
    expect(cellState('2026-11-20', [plan('CIVIL', '2026-11-20', 'APPROVED', '2026-11-19T15:53:45.96')]).state).toBe('approved')
  })
  it('approved but sent after 16:00 is late (FACTORY 19 Nov, 20:04)', () => {
    expect(cellState('2026-11-19', [plan('FACTORY', '2026-11-19', 'APPROVED', '2026-11-18T20:04:47.2')]).state).toBe('approved_late')
  })
  it('one late plan makes the day late (ROADS 18 Nov)', () => {
    const s = cellState('2026-11-18', [
      plan('ROADS', '2026-11-18', 'APPROVED', '2026-11-16T11:21:07'),
      plan('ROADS', '2026-11-18', 'APPROVED', '2026-11-17T20:43:19'),
    ])
    expect(s).toEqual({ state: 'approved_late', submittedAt: '2026-11-17T20:43:19' })
  })
  it('sent and waiting: on time or late', () => {
    expect(cellState('2026-11-13', [plan('AGRICULTURE', '2026-11-13', 'SUBMITTED', '2026-11-12T14:33:28')]).state).toBe('sent')
    expect(cellState('2026-11-13', [plan('IRRIGATION', '2026-11-13', 'SUBMITTED', '2026-11-12T23:07:50')]).state).toBe('sent_late')
  })
  it('exactly 16:00 is still on time', () => {
    expect(cellState('2026-11-13', [plan('ROADS', '2026-11-13', 'SUBMITTED', '2026-11-12T16:00:59')]).state).toBe('sent')
  })
  it('approved beats a draft beside it (ROADS 14 Nov)', () => {
    expect(cellState('2026-11-14', [
      plan('ROADS', '2026-11-14', 'DRAFT', '2026-11-13T14:46:37'),
      plan('ROADS', '2026-11-14', 'APPROVED', '2026-11-13T14:19:32'),
    ]).state).toBe('approved')
  })
  it('a draft that was sent once is sent back; one never sent is a draft', () => {
    expect(cellState('2026-11-14', [plan('ROADS', '2026-11-14', 'DRAFT', '2026-11-13T14:46:37')]).state).toBe('sent_back')
    expect(cellState('2026-11-14', [plan('ROADS', '2026-11-14', 'REJECTED', '2026-11-13T14:46:37')]).state).toBe('sent_back')
    expect(cellState('2026-11-20', [plan('LAND DEV', '2026-11-20', 'DRAFT')]).state).toBe('draft')
  })
  it('cancelled plans do not count', () => {
    expect(cellState('2026-11-15', [plan('FACTORY', '2026-11-15', 'CANCELLED')]).state).toBe('none')
  })
})

describe('buildPlanSubmissions', () => {
  const plans = [
    plan('CIVIL', '2026-11-20', 'APPROVED', '2026-11-19T15:44:00'),
    plan('CIVIL', '2026-11-19', 'APPROVED', '2026-11-18T14:16:18'),
    plan('FACTORY', '2026-11-20', 'APPROVED', '2026-11-19T21:19:52'),
    plan('LAND DEV', '2026-11-20', 'DRAFT'),
    plan('ROADS', '2026-10-30', 'APPROVED', '2026-10-29T10:00:00'), // outside the window
    { ...plan('SANDBOX', '2026-11-20', 'APPROVED', '2026-11-19T10:00:00'), factoryCode: 'SANDBOX' },
  ]
  const b = buildPlanSubmissions(F, '2026-11-21', plans)

  it('shows 14 days ending on the day asked for', () => {
    expect(b.days).toHaveLength(14)
    expect(b.days[0]).toBe('2026-11-08')
    expect(b.days.at(-1)).toBe('2026-11-21')
  })
  it('lists every department seen, even one with nothing in the window', () => {
    expect(b.departments).toEqual(['CIVIL', 'FACTORY', 'LAND DEV', 'ROADS'])
    expect(b.cells.filter(c => c.department === 'ROADS').every(c => c.state === 'none')).toBe(true)
  })
  it('counts on-time days and senders per day', () => {
    expect(b.onTime).toEqual({ CIVIL: 2, FACTORY: 0, 'LAND DEV': 0, ROADS: 0 })
    expect(b.sent['2026-11-20']).toBe(2)
    expect(b.sent['2026-11-21']).toBe(0)
  })
  it('the cell carries its plans', () => {
    const c = b.cells.find(x => x.department === 'FACTORY' && x.day === '2026-11-20')!
    expect(c.state).toBe('approved_late')
    expect(c.plans).toHaveLength(1)
    expect(c.plans[0]!.submittedAt).toBe('2026-11-19T21:19:52')
  })
})
