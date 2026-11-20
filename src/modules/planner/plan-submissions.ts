/**
 * Plan submissions for the Maintenance page (operator 2026-11-20): FactorySuite's
 * own "Plan submissions" board. Each department plans tomorrow's machine-shifts
 * and must send the plan by 16:00 the day before; this says, per department and
 * day, how far it got and whether it was on time.
 *
 * Built from the plan headers alone (GET /fuel/plans). Rules, checked against
 * FactorySuite's board for 8–21 Nov 2026:
 *  - CANCELLED plans do not count.
 *  - The furthest stage wins: approved, then sent, then sent back, then draft.
 *    "Sent back" is a REJECTED or WITHDRAWN plan, or a DRAFT that was sent
 *    once (it carries submittedAt), i.e. sent and returned, not sent again.
 *  - Late: a plan at that stage was sent after 16:00 the day before. FactorySuite
 *    stamps submittedAt in its local wall clock (EAT) with no offset, so it is
 *    compared as text with `${dayBefore}T16:00`.
 *  - On time: days a department's plan was sent (or approved) and not late.
 */

import type { RaiFactorySuiteWorkPlanRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'

export const DUE_HOUR = 16
export const WINDOW_DAYS = 14

export type SubmissionState =
  | 'approved' | 'approved_late'
  | 'sent' | 'sent_late'
  | 'sent_back' | 'draft' | 'none'

export interface SubmissionPlan {
  planCode:    string
  status:      string
  submittedAt: string | null
  submittedBy: string | null
  reviewedAt:  string | null
  reviewedBy:  string | null
  note:        string | null
}

export interface SubmissionCell {
  department:  string
  day:         string
  state:       SubmissionState
  /** The latest send among the plans at that stage (local wall clock). */
  submittedAt: string | null
  plans:       SubmissionPlan[]
}

export interface PlanSubmissions {
  factory:     string
  dueHour:     number
  /** The days shown, oldest first; the last is the day asked for. */
  days:        string[]
  departments: string[]
  cells:       SubmissionCell[]
  /** Days each department sent on time, of `days.length`. */
  onTime:      Record<string, number>
  /** Departments that sent (on time or late, approved or not), per day. */
  sent:        Record<string, number>
}

const DAY_MS = 86_400_000
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** Every day a plan covers (FactorySuite plans are one day, but say a range). */
function planDays(p: RaiFactorySuiteWorkPlanRow): string[] {
  const out: string[] = []
  const end = p.endDate && p.endDate >= p.startDate ? p.endDate : p.startDate
  for (let d = p.startDate; d <= end && out.length < 31; d = addDays(d, 1)) out.push(d)
  return out
}

const isSentBack = (p: RaiFactorySuiteWorkPlanRow) =>
  p.status === 'REJECTED' || p.status === 'WITHDRAWN' || (p.status === 'DRAFT' && Boolean(p.submittedAt))

const lateFor = (day: string, submittedAt: string | null | undefined) =>
  Boolean(submittedAt) && submittedAt!.slice(0, 16) > `${addDays(day, -1)}T${String(DUE_HOUR).padStart(2, '0')}:00`

export function cellState(day: string, plans: RaiFactorySuiteWorkPlanRow[]): { state: SubmissionState; submittedAt: string | null } {
  const live = plans.filter(p => p.status !== 'CANCELLED')
  const latest = (ps: RaiFactorySuiteWorkPlanRow[]) =>
    ps.map(p => p.submittedAt ?? null).filter((s): s is string => Boolean(s)).sort().at(-1) ?? null

  const approved = live.filter(p => p.status === 'APPROVED')
  if (approved.length) {
    const late = approved.some(p => lateFor(day, p.submittedAt))
    return { state: late ? 'approved_late' : 'approved', submittedAt: latest(approved) }
  }
  const sent = live.filter(p => p.status === 'SUBMITTED')
  if (sent.length) {
    const late = sent.some(p => lateFor(day, p.submittedAt))
    return { state: late ? 'sent_late' : 'sent', submittedAt: latest(sent) }
  }
  const back = live.filter(isSentBack)
  if (back.length) return { state: 'sent_back', submittedAt: latest(back) }
  if (live.some(p => p.status === 'DRAFT')) return { state: 'draft', submittedAt: null }
  return { state: 'none', submittedAt: null }
}

const SENT: SubmissionState[] = ['approved', 'approved_late', 'sent', 'sent_late']
const ON_TIME: SubmissionState[] = ['approved', 'sent']

/**
 * The board for the WINDOW_DAYS days ending on `day`. `plans` may cover more
 * days than that: every department seen in them gets a row, so a department
 * that sent nothing in the window still shows as not started.
 */
export function buildPlanSubmissions(factory: string, day: string, plans: RaiFactorySuiteWorkPlanRow[]): PlanSubmissions {
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(day, i - WINDOW_DAYS + 1))
  const inWindow = new Set(days)

  const departments = new Set<string>()
  const byCell = new Map<string, RaiFactorySuiteWorkPlanRow[]>()
  for (const p of plans) {
    if (p.factoryCode && p.factoryCode !== factory) continue
    const dept = (p.department ?? '').trim()
    if (!dept) continue
    departments.add(dept)
    for (const d of planDays(p)) {
      if (!inWindow.has(d)) continue
      const k = `${dept}|${d}`
      const list = byCell.get(k)
      if (list) list.push(p)
      else byCell.set(k, [p])
    }
  }

  const depts = [...departments].sort((a, b) => a.localeCompare(b))
  const cells: SubmissionCell[] = []
  const onTime: Record<string, number> = {}
  const sent: Record<string, number> = Object.fromEntries(days.map(d => [d, 0]))
  for (const dept of depts) {
    onTime[dept] = 0
    for (const d of days) {
      const ps = byCell.get(`${dept}|${d}`) ?? []
      const { state, submittedAt } = cellState(d, ps)
      if (ON_TIME.includes(state)) onTime[dept]! += 1
      if (SENT.includes(state)) sent[d]! += 1
      cells.push({
        department: dept,
        day: d,
        state,
        submittedAt,
        plans: ps
          .filter(p => p.status !== 'CANCELLED')
          .map(p => ({
            planCode:    p.planCode,
            status:      p.status,
            submittedAt: p.submittedAt ?? null,
            submittedBy: p.submittedBy ?? null,
            reviewedAt:  p.reviewedAt ?? null,
            reviewedBy:  p.reviewedBy ?? null,
            note:        p.decisionNote ?? null,
          }))
          .sort((a, b) => a.planCode.localeCompare(b.planCode, undefined, { numeric: true })),
      })
    }
  }
  return { factory, dueHour: DUE_HOUR, days, departments: depts, cells, onTime, sent }
}
