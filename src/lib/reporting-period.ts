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
import { fleetDayStart, fleetDayKey } from './provider-time.js'

/** org + day → period id. Periods are immutable once created. */
const cache   = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

/**
 * The FLEET day containing `at` — 00:00 to 23:59:59.999 Africa/Nairobi.
 *
 * Was `setHours(0, 0, 0, 0)`, which is the HOST PROCESS's timezone and not a
 * statement about the fleet at all. On the UTC box this runs on, that put the
 * boundary at 03:00 EAT: every trip started between midnight and three in the
 * morning was filed under the previous day's reporting period, and the operator
 * saw an early-hours haul land on the wrong sheet.
 *
 * It was invisible on a developer machine in EAT and wrong in production, which
 * is the worst combination — `provider-time` exists precisely so that "which
 * day is this" has ONE answer regardless of where the code runs.
 */
function dayBounds(at: Date): { start: Date; end: Date } {
  const start = fleetDayStart(at)
  return { start, end: new Date(start.getTime() + 86_400_000 - 1) }
}

/**
 * Note `fleetDayKey`, not `dayBounds(at).start` sliced to a date.
 *
 * `fleetDayStart` returns the INSTANT EAT-midnight falls on, which in UTC is
 * 21:00 the previous evening — so taking its UTC calendar components labels
 * every fleet day with the day BEFORE it. That off-by-one has shipped in this
 * codebase once already; see `fleetDayKey`'s own note. Here it would have
 * collided two adjacent days onto one cache slot for the three hours either
 * side of the boundary.
 */
const keyOf = (orgId: string, at: Date) =>
  `${orgId}:${fleetDayKey(at).toISOString().slice(0, 10)}`

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
  // From fleetDayKey, NOT from `start`'s calendar components. `start` is 21:00
  // UTC the previous evening, so getDate() on a UTC box names the day before —
  // the label would have disagreed with the period it labels.
  const label = `Live ${fleetDayKey(at).toISOString().slice(0, 10)}`

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
