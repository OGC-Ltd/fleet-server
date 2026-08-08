/**
 * Find-or-create the ReportingPeriod covering a given moment.
 *
 * Every durable fuel/trip row carries a non-null `reportingPeriodId`, so
 * anything that writes one needs a period first. This used to live inside
 * `simulation.persistence.ts` and could only ever resolve the period covering
 * NOW — fine for a live simulator, useless for a backfill: importing last
 * week's fuel drains would have filed them all under today.
 *
 * So the moment is a parameter, and the DAILY period is the one containing it.
 *
 * Caching is keyed on org + calendar day rather than org alone, because a
 * backfill walks across many days in one run and a single-slot cache would
 * thrash on every row.
 */

import { prisma } from './prisma.js'

/** org + day → period id. Periods are immutable once created. */
const cache   = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

/** Local-day bounds for `at`, matching how the DAILY periods were seeded. */
function dayBounds(at: Date): { start: Date; end: Date } {
  const start = new Date(at); start.setHours(0, 0, 0, 0)
  const end   = new Date(at); end.setHours(23, 59, 59, 999)
  return { start, end }
}

const keyOf = (orgId: string, at: Date) => `${orgId}:${dayBounds(at).start.toISOString().slice(0, 10)}`

async function resolve(orgId: string, at: Date): Promise<string> {
  // An existing period that CONTAINS the moment wins, whatever its type — a
  // WEEKLY or MONTHLY period created by hand is still the right home for the
  // row, and creating an overlapping DAILY one beside it would split a
  // period's rows across two ids.
  const existing = await prisma.reportingPeriod.findFirst({
    where:   { organisationId: orgId, periodStart: { lte: at }, periodEnd: { gte: at } },
    orderBy: { periodStart: 'desc' },
    select:  { id: true },
  })
  if (existing) return existing.id

  const { start, end } = dayBounds(at)
  const label = `Live ${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`

  // Two workers can race here for the same day. There is no unique constraint
  // on (org, start) to upsert against, so a loser re-reads rather than
  // creating a duplicate.
  try {
    const created = await prisma.reportingPeriod.create({
      data:   { organisationId: orgId, label, periodStart: start, periodEnd: end, periodType: 'DAILY' },
      select: { id: true },
    })
    return created.id
  } catch {
    const raced = await prisma.reportingPeriod.findFirst({
      where:   { organisationId: orgId, periodStart: { lte: at }, periodEnd: { gte: at } },
      orderBy: { periodStart: 'desc' },
      select:  { id: true },
    })
    if (raced) return raced.id
    throw new Error(`Could not resolve a reporting period for org ${orgId} at ${at.toISOString()}`)
  }
}

/**
 * Id of the reporting period covering `at`, creating a DAILY one if none
 * exists. Concurrent callers for the same org-day share one round trip.
 */
export async function getOrCreatePeriodFor(orgId: string, at: Date): Promise<string> {
  const key = keyOf(orgId, at)

  const hit = cache.get(key)
  if (hit) return hit

  let inflight = pending.get(key)
  if (!inflight) {
    inflight = resolve(orgId, at)
      .then((id) => { cache.set(key, id); return id })
      .finally(() => { pending.delete(key) })
    pending.set(key, inflight)
  }
  return inflight
}

/** The period covering now — the live path's shorthand. */
export const getOrCreateCurrentPeriod = (orgId: string): Promise<string> =>
  getOrCreatePeriodFor(orgId, new Date())
