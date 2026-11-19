/**
 * FactorySuite work plan lines as items the watch keeps, one row per plan
 * line. Pure.
 *
 * Operator 2026-11-19: "if an item was drafted and awaiting approval we should
 * update it based on the new changes either accepted or rejected no point of
 * having duplicates records", and "do not restrict … let it be dynamic but
 * ensure that we don't get a duplicated on the plan line".
 *
 * So an item is a plan line, keyed by FactorySuite's own line id: a line on a
 * pending plan is updated in place when the plan is approved or rejected, or
 * when the line is edited, and the same line is never kept twice. A machine
 * can be on any number of plans and shifts; each of its lines is its own item.
 */

import type { RaiFactorySuiteWorkPlanLine, RaiFactorySuiteWorkPlanRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'

/** A plan line as the watch keeps it, with the plan fields it needs. */
export interface WorkPlanItem {
  /** FactorySuite's line id: one item per plan line. */
  lineId: string
  day: string
  machine: string
  shiftNo: number | null
  planId: string
  planCode: string
  department: string | null
  /** The plan's status: what the item is now (DRAFT, SUBMITTED, APPROVED, REJECTED, CANCELLED). */
  status: string
  taskId: string | null
  /** The line as FactorySuite returned it, for the field comparison. */
  line: RaiFactorySuiteWorkPlanLine
  reviewedBy: string | null
  reviewedAt: string | null
}

/**
 * Every active line of these plans as one item. A line id that comes back
 * twice in one read (FactorySuite repeating a row) is kept once, the first.
 */
export function itemsFromPlans(plans: RaiFactorySuiteWorkPlanRow[]): WorkPlanItem[] {
  const byLine = new Map<string, WorkPlanItem>()
  for (const p of plans) {
    for (const l of p.lines ?? []) {
      if (l.active === false || !l.id || byLine.has(l.id)) continue
      byLine.set(l.id, {
        lineId: l.id, day: p.startDate, machine: l.machine, shiftNo: l.shiftNo ?? null,
        planId: p.id, planCode: p.planCode, department: p.department ?? null, status: p.status,
        taskId: l.taskId ?? null, line: l,
        reviewedBy: p.reviewedBy ?? null, reviewedAt: p.reviewedAt ?? null,
      })
    }
  }
  return [...byLine.values()]
}

/** Line fields compared, in the order an edit lists them. */
const LINE_FIELDS = [
  'machine', 'shiftNo', 'shiftStart', 'plannedHours', 'fullTank', 'litresRequested', 'plannedKm',
  'activity', 'workLocation', 'fuelingLocation', 'operator', 'secondOperator', 'thirdOperator', 'supervisor',
  'expectedOutput', 'decision', 'notes',
] as const

/** A value as compared and stored: null for absent or empty, the rest as text. */
export function asText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Whitespace and case do not count ("Frank" vs "FRANK "). */
const same = (a: string | null, b: string | null) =>
  (a ?? '').replace(/\s+/g, ' ').toUpperCase() === (b ?? '').replace(/\s+/g, ' ').toUpperCase()

export interface ItemEdit { field: string; from: string | null; to: string | null }

/**
 * What differs between the kept item and the new read of the same line: the
 * plan's status, the day, and the line's own fields. Empty when nothing did.
 */
export function itemEdits(prev: Pick<WorkPlanItem, 'status' | 'day' | 'line'>, next: Pick<WorkPlanItem, 'status' | 'day' | 'line'>): ItemEdit[] {
  const out: ItemEdit[] = []
  if (!same(prev.status, next.status)) out.push({ field: 'status', from: asText(prev.status), to: asText(next.status) })
  if (prev.day !== next.day) out.push({ field: 'day', from: prev.day, to: next.day })
  for (const f of LINE_FIELDS) {
    const a = asText(prev.line?.[f]), b = asText(next.line?.[f])
    if (!same(a, b)) out.push({ field: f, from: a, to: b })
  }
  return out
}
