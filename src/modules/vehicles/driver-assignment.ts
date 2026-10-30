/**
 * Who was driving a vehicle at a given moment.
 *
 * A vehicle's assignments come from three places: an organisation's driver
 * list (a standing posting, open until someone ends it), POST
 * /vehicles/:id/assignments, and the Control Tech webhooks, which open one row
 * per cane dispatch or sales run (`controltech:dispatch:<id>`,
 * `controltech:sale:<id>`) and close it when the run's return time arrives.
 *
 * A run whose return never arrives stays open for ever. Measured 2026-10-30 on
 * SUKARI: 884 open dispatch rows on 262 trucks, 698 of them over a week old,
 * and 81 trucks naming two or more different drivers at once, while a closed
 * run lasts 13.7 h at the median and 38.9 h at p90. Every reader took
 * `unassignedAt: null, take: 1`, so which of those drivers a truck showed, and
 * which one its speeding was stamped with, was whatever row Postgres returned.
 *
 * The rule, in one place:
 *
 *   · the assignment that covers the moment and STARTED LAST wins — a run
 *     names who actually took the truck out, so it overrides the standing
 *     posting while it runs, and a newer run overrides an older one;
 *   · a run with no return time counts as ended RUN_OPEN_MAX_MS after it began.
 *     Standing postings have no such limit.
 */
import { Prisma } from '../../../generated/prisma/client.js'

/** How long an un-returned Control Tech run is still taken to hold its truck. Above p90 (38.9 h). */
export const RUN_OPEN_MAX_MS = 48 * 60 * 60_000

const RUN_PREFIX = 'controltech:'

export interface AssignmentSpan {
  assignedAt:   Date
  unassignedAt: Date | null
  notes:        string | null
}

/** A per-run link from a Control Tech dispatch or sale, not a standing posting. */
export const isRun = (notes: string | null | undefined): boolean => !!notes?.startsWith(RUN_PREFIX)

/** When this assignment stops covering its vehicle; null = still covering. */
export function coversUntil(a: AssignmentSpan): Date | null {
  if (a.unassignedAt) return a.unassignedAt
  return isRun(a.notes) ? new Date(a.assignedAt.getTime() + RUN_OPEN_MAX_MS) : null
}

/** The assignment that held the vehicle at `at`, or null. Pure. */
export function assignmentAt<T extends AssignmentSpan>(rows: readonly T[], at: Date): T | null {
  let best: T | null = null
  for (const a of rows) {
    if (a.assignedAt > at) continue
    const until = coversUntil(a)
    if (until && until <= at) continue
    if (!best || a.assignedAt > best.assignedAt) best = a
  }
  return best
}

/**
 * The same rule as a query filter, for "who holds it NOW". Use with
 * `orderBy: { assignedAt: 'desc' }, take: 1`, which supplies "started last".
 *
 * The notes test is spelled out for NULL: `NOT { startsWith }` alone drops
 * every row whose notes are NULL, which is most manual postings.
 */
export function currentAssignmentWhere(now = new Date()): Prisma.VehicleAssignmentWhereInput {
  return {
    assignedAt: { lte: now },
    OR: [
      { unassignedAt: { gt: now } },
      { unassignedAt: null, notes: null },
      { unassignedAt: null, NOT: { notes: { startsWith: RUN_PREFIX } } },
      { unassignedAt: null, assignedAt: { gte: new Date(now.getTime() - RUN_OPEN_MAX_MS) } },
    ],
  }
}

/** Newest first: with `currentAssignmentWhere`, the first row is the one that holds the vehicle. */
export const CURRENT_ASSIGNMENT_ORDER = { assignedAt: 'desc' } as const
