/**
 * The Alerts page's rules, kept free of the database and of every import so
 * they can be pinned in tests and shared with the fuel module: how an alert's
 * stored state reads as open / escalated / de-escalated, which decisions are
 * still open to it, and how the two kinds share one page of results.
 *
 * Asked for 2026-10-12: fuel and overspeeding alerts on one page, escalated
 * and de-escalated there, for people who hold several organisations — "list
 * all organizations alerts and we can filter".
 *
 * Who may read what is alerts.scope; it needs the authz subject, which this
 * file must not import (fuel-followup.repository uses it, and the repair unit
 * tests load that without an environment).
 */

export const ALERT_KINDS = ['fuel', 'speeding'] as const
export type AlertKindSlug = (typeof ALERT_KINDS)[number]

export const ALERT_STATUSES = ['open', 'escalated', 'deescalated'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

// ── Where an alert stands ───────────────────────────────────────────────────

/**
 * A fuel alert's bucket, from FuelTheft.reviewStatus. Escalated covers both
 * escalations (a confirmed theft, a faulty probe); DISMISSED and UNDER_REVIEW
 * are off the map without a decision (cleared with another alert on the unit,
 * or deleted before Delete was retired and still in its case), so still open.
 */
export function fuelStatus(reviewStatus: string | null | undefined): AlertStatus {
  if (reviewStatus === 'CONFIRMED_THEFT' || reviewStatus === 'PROBE_FAULT') return 'escalated'
  if (reviewStatus === 'NOT_THEFT') return 'deescalated'
  return 'open'
}

export function speedingStatus(reviewStatus: string | null | undefined): AlertStatus {
  if (reviewStatus === 'ESCALATED') return 'escalated'
  if (reviewStatus === 'DEESCALATED') return 'deescalated'
  return 'open'
}

/** A fuel decision: escalated as one of the reasons, or de-escalated. */
export type FuelChoice = 'theft' | 'probe_fault' | 'not_theft'

/**
 * The fuel decisions still open to an alert.
 *
 * Undecided: all three. Decided as a theft or not a theft: the other two,
 * which is what changing one's mind is. Escalated as a faulty probe: none, as
 * the case now sits in Fuel Audit with a job in Repairs and closes on the
 * repair. Deleted before Delete was retired and still waiting in its case:
 * theft or not a theft, which also closes the case. A case already closed
 * there: none.
 */
export function fuelChoices(row: {
  reviewStatus?: string | null
  followUpStatus?: string | null
}): FuelChoice[] {
  const status = row.reviewStatus ?? null
  const caseStatus = row.followUpStatus ?? null
  if (caseStatus) return caseStatus === 'OPEN' || caseStatus === 'ACCEPTED' ? ['theft', 'not_theft'] : []
  if (status === 'CONFIRMED_THEFT') return ['probe_fault', 'not_theft']
  if (status === 'NOT_THEFT') return ['theft', 'probe_fault']
  if (status === 'PROBE_FAULT') return []
  return ['theft', 'probe_fault', 'not_theft']
}

export type Outcome = 'ESCALATED' | 'DEESCALATED'

/** The speeding decisions open to an episode: both until decided, then the other. */
export function speedingChoices(reviewStatus: string | null | undefined): Outcome[] {
  if (reviewStatus === 'ESCALATED') return ['DEESCALATED']
  if (reviewStatus === 'DEESCALATED') return ['ESCALATED']
  return ['ESCALATED', 'DEESCALATED']
}

// ── One page across two tables ──────────────────────────────────────────────

export interface Cursor { at: Date; id: string }

/** `<epoch ms>.<id>`: the last row of the page, newest first. */
export const encodeCursor = (c: Cursor): string => `${c.at.getTime()}.${c.id}`

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  const dot = raw.indexOf('.')
  const ms = Number(raw.slice(0, dot))
  const id = raw.slice(dot + 1)
  if (dot < 1 || !Number.isInteger(ms) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  return { at: new Date(ms), id }
}

/**
 * Newest first, ties broken by id in BYTE order: the SQL orders and pages on
 * `id COLLATE "C"`, and the merge must agree with it exactly or a row on a
 * tied timestamp is skipped or shown twice across a page boundary.
 */
export function newestFirst(a: { at: Date; id: string }, b: { at: Date; id: string }): number {
  const d = b.at.getTime() - a.at.getTime()
  if (d !== 0) return d
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * One page from lists that were each read with the same cursor and a limit of
 * `limit + 1`. Whatever is not taken is still after the new cursor, so the
 * next page finds it.
 */
export function mergePage<T extends { at: Date; id: string }>(lists: T[][], limit: number) {
  const all = lists.flat().sort(newestFirst)
  const rows = all.slice(0, limit)
  const hasNextPage = all.length > limit
  const last = rows.at(-1)
  return { rows, hasNextPage, cursor: hasNextPage && last ? encodeCursor(last) : null }
}

/** `%` and `_` are wildcards to ILIKE; a plate search means them literally. */
export const likeTerm = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
