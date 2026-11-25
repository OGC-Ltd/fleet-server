/**
 * Issued fuel, kept (2026-11-26, operator: "capture the issued fuel for the
 * day and persist").
 *
 * Every pump fuelling FactorySuite lists (`GET /fuel/issues`) is written to
 * `factorysuite_fuel_issues`, one row per issue, as read: the litres, the
 * voucher, the times and the whole row. A day's issued fuel is then on record
 * here whether or not FactorySuite answers later, and the Fuel page reads the
 * kept rows beside the live ones (work-plans.service factoryFuelFor).
 *
 * When: each RaiFactorySuite reconcile pass (5 min) re-reads the last
 * ISSUE_REREAD_DAYS days, and a fuel.issue.* webhook asks for a pass a moment
 * later (requestFuelIssueKeep). The first pass after a start reads back from
 * the last kept day (or from ISSUES_FROM, FactorySuite's data reset, when
 * nothing is kept yet), ISSUE_CHUNK_DAYS at a time, so a gap while the server
 * was down fills itself.
 *
 * An issue is upserted on every read that lists it. One that a complete read
 * of its day no longer lists gets `goneAt` (FactorySuite deleted or voided
 * it) and is left out of the page; it is never deleted here. A read that came
 * back at the feed's row limit may be cut short, so it marks nothing gone.
 */

import type { RaiFactorySuiteFuelIssueRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'

/** The first day FactorySuite has real data for (its 09 Nov reset). */
export const ISSUES_FROM = '2026-11-09'
/** Days each pass reads again, today included: late keying and edits land here. */
export const ISSUE_REREAD_DAYS = 3
/** Days in one read; the feed refuses more than 31. */
export const ISSUE_CHUNK_DAYS = 31
/** The feed's row limit (client listFuelIssues asks for this many). */
export const ISSUE_ROW_LIMIT = 1000

export interface KeptIssue {
  /** "<factory>|<issue id>" */
  id: string
  organisationId: string
  factoryCode: string
  issueId: string
  day: string
  machine: string
  requestId: string | null
  siv: string | null
  litres: number | null
  fuelingStart: string | null
  fuelingEnd: string | null
  completed: boolean | null
  row: RaiFactorySuiteFuelIssueRow
}

export const issueKey = (factory: string, issueId: string) => `${factory}|${issueId}`

/** The rows to upsert for one read: each issue with an id, a machine and a day. */
export function keptIssues(factory: string, orgId: string, rows: RaiFactorySuiteFuelIssueRow[]): KeptIssue[] {
  const out = new Map<string, KeptIssue>()
  for (const r of rows) {
    const issueId = String(r.id ?? '').trim()
    const day = String(r.issueDate ?? '').slice(0, 10)
    if (!issueId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !r.machine) continue
    out.set(issueKey(factory, issueId), {
      id: issueKey(factory, issueId),
      organisationId: orgId,
      factoryCode: factory,
      issueId,
      day,
      machine: r.machine,
      requestId: r.requestId ?? null,
      siv: r.siv?.trim() || null,
      litres: typeof r.quantityIssued === 'number' && Number.isFinite(r.quantityIssued) ? r.quantityIssued : null,
      fuelingStart: r.fuelingStart ?? null,
      fuelingEnd: r.fuelingEnd ?? null,
      completed: typeof r.completed === 'boolean' ? r.completed : null,
      row: r,
    })
  }
  return [...out.values()]
}

/** `from`..`to` (inclusive) in reads of at most ISSUE_CHUNK_DAYS days, oldest first. */
export function issueChunks(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = []
  for (let a = from; a <= to; a = addDays(a, ISSUE_CHUNK_DAYS)) {
    const b = addDays(a, ISSUE_CHUNK_DAYS - 1)
    out.push({ from: a, to: b < to ? b : to })
  }
  return out
}

/**
 * Where a pass starts reading: ISSUE_REREAD_DAYS back from today; on the first
 * pass after a start, from the last kept day less that (or ISSUES_FROM when
 * nothing is kept), so the days the server missed are read too.
 */
export function issueReadFrom(today: string, lastKeptDay: string | null, firstPass: boolean): string {
  const recent = addDays(today, -(ISSUE_REREAD_DAYS - 1))
  if (!firstPass) return recent < ISSUES_FROM ? ISSUES_FROM : recent
  if (!lastKeptDay) return ISSUES_FROM
  const back = addDays(lastKeptDay, -(ISSUE_REREAD_DAYS - 1))
  const from = back < recent ? back : recent
  return from < ISSUES_FROM ? ISSUES_FROM : from
}

/**
 * The page's issues for a range: the live read where it has them, the kept
 * rows where it does not (FactorySuite down, or a row it no longer lists that
 * was not marked gone yet). Live wins on the same issue id; a kept row's
 * stored copy is what FactorySuite last said.
 */
export function mergeIssues(live: RaiFactorySuiteFuelIssueRow[], kept: RaiFactorySuiteFuelIssueRow[]): RaiFactorySuiteFuelIssueRow[] {
  const byId = new Map<string, RaiFactorySuiteFuelIssueRow>()
  for (const r of kept) if (r?.id) byId.set(String(r.id), r)
  for (const r of live) if (r?.id) byId.set(String(r.id), r)
  return [...byId.values()]
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
