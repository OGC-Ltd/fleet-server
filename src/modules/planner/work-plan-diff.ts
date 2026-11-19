/**
 * What changed on a FactorySuite work plan between two reads. Pure: the watch
 * (work-plan-watch.ts) keeps the last read of every plan and hands the old and
 * the new one here.
 *
 * Operator 2026-11-19: "we need to ensure that we monitor any changes happening
 * on the workplan from factory suite". FactorySuite sends no event when a plan
 * is created, edited or cancelled (and on 19 Nov no fuelplan.* event had
 * arrived at all in 72 h), so the watch compares reads instead of trusting
 * events: a plan WP-261118-FAC cancelled and replaced by WP-261118-FAC-3 shows
 * as the old one's status going to CANCELLED and the new one appearing.
 *
 * Lines are matched by FactorySuite's own line id. A line whose machine,
 * shift, hours, litres, people or place changed is one `line_changed` per
 * field, so the list reads "EX-12, shift 1: hours 10 → 8".
 */

import type { RaiFactorySuiteWorkPlanLine, RaiFactorySuiteWorkPlanRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'

export type WorkPlanChangeKind =
  | 'plan_added'      // a plan we had not seen
  | 'plan_status'     // DRAFT → SUBMITTED → APPROVED, or CANCELLED / REJECTED
  | 'plan_changed'    // a plan field other than status (day, department, reviewer, note)
  | 'plan_removed'    // FactorySuite no longer returns it for its day
  | 'plan_restored'   // returned again after being removed
  | 'line_added'
  | 'line_removed'
  | 'line_changed'

export interface WorkPlanChange {
  kind:      WorkPlanChangeKind
  planId:    string
  planCode:  string
  department: string | null
  day:       string
  lineId:    string | null
  taskId:    string | null
  machine:   string | null
  shiftNo:   number | null
  field:     string | null
  fromValue: string | null
  toValue:   string | null
}

/** Plan fields compared, besides status (its own kind) and the lines. */
const PLAN_FIELDS = ['startDate', 'endDate', 'department', 'title', 'submittedBy', 'reviewedBy', 'decisionNote'] as const

/** Line fields compared. Order is the order the changes are listed in. */
const LINE_FIELDS = [
  'machine', 'shiftNo', 'shiftStart', 'plannedHours', 'fullTank', 'litresRequested', 'plannedKm',
  'activity', 'workLocation', 'fuelingLocation', 'operator', 'secondOperator', 'thirdOperator', 'supervisor',
  'crews', 'expectedOutput', 'decision', 'decisionNote', 'active', 'notes',
] as const

/** A value as stored: null for absent or empty, numbers and booleans as text. */
export function asText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Whitespace and case do not count as a change ("Frank" vs "FRANK "). */
const same = (a: string | null, b: string | null) =>
  (a ?? '').replace(/\s+/g, ' ').toUpperCase() === (b ?? '').replace(/\s+/g, ' ').toUpperCase()

function base(p: RaiFactorySuiteWorkPlanRow, l?: RaiFactorySuiteWorkPlanLine | null): Omit<WorkPlanChange, 'kind' | 'field' | 'fromValue' | 'toValue'> {
  return {
    planId: p.id,
    planCode: p.planCode,
    department: p.department ?? null,
    day: p.startDate,
    lineId: l?.id ?? null,
    taskId: l?.taskId ?? null,
    machine: l?.machine ?? null,
    shiftNo: l?.shiftNo ?? null,
  }
}

/** A line's own summary, for line_added / line_removed. */
export function lineSummary(l: RaiFactorySuiteWorkPlanLine): string {
  const fuel = l.fullTank ? 'full tank' : l.litresRequested != null ? `${l.litresRequested} L` : null
  return [
    `shift ${l.shiftNo ?? '?'}${l.shiftStart ? ` ${l.shiftStart.slice(0, 5)}` : ''}`,
    l.plannedHours != null ? `${l.plannedHours} h` : null,
    fuel,
    l.activity || null,
    l.workLocation ? `at ${l.workLocation}` : null,
  ].filter(Boolean).join(', ')
}

/**
 * The changes from `prev` to `next`. `prev` null: the plan is new. `next`
 * null: it is gone. Both null: nothing.
 */
export function diffWorkPlan(prev: RaiFactorySuiteWorkPlanRow | null, next: RaiFactorySuiteWorkPlanRow | null): WorkPlanChange[] {
  if (!prev && !next) return []
  if (!prev) {
    const p = next!
    return [{ ...base(p), kind: 'plan_added', field: null, fromValue: null, toValue: `${p.status}, ${(p.lines ?? []).length} lines` }]
  }
  if (!next) {
    return [{ ...base(prev), kind: 'plan_removed', field: null, fromValue: prev.status, toValue: null }]
  }

  const out: WorkPlanChange[] = []
  if (!same(prev.status, next.status)) {
    out.push({ ...base(next), kind: 'plan_status', field: 'status', fromValue: asText(prev.status), toValue: asText(next.status) })
  }
  for (const f of PLAN_FIELDS) {
    const a = asText(prev[f]), b = asText(next[f])
    if (!same(a, b)) out.push({ ...base(next), kind: 'plan_changed', field: f, fromValue: a, toValue: b })
  }

  const before = new Map((prev.lines ?? []).map(l => [l.id, l]))
  const after = new Map((next.lines ?? []).map(l => [l.id, l]))
  for (const [id, l] of after) {
    const o = before.get(id)
    if (!o) {
      out.push({ ...base(next, l), kind: 'line_added', field: null, fromValue: null, toValue: lineSummary(l) })
      continue
    }
    for (const f of LINE_FIELDS) {
      const a = asText(o[f]), b = asText(l[f])
      if (!same(a, b)) out.push({ ...base(next, l), kind: 'line_changed', field: f, fromValue: a, toValue: b })
    }
  }
  for (const [id, o] of before) {
    if (!after.has(id)) out.push({ ...base(prev, o), kind: 'line_removed', field: null, fromValue: lineSummary(o), toValue: null })
  }
  return out
}
