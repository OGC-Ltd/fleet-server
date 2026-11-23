/**
 * Who was driving a vehicle at a given moment.
 *
 * A vehicle's assignments come from three places: an organisation's driver
 * list (a standing posting, open until someone ends it), POST
 * /vehicles/:id/assignments, and the Control Tech webhooks, which open one row
 * per cane dispatch or sales run (`controltech:dispatch:<id>`,
 * `controltech:sale:<id>`).
 *
 * Until 2026-11-23 the run's return time closed it, and a run whose return
 * never arrived stayed open for ever. Measured 2026-10-30 on
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
 *     posting, and a newer run overrides an older one;
 *   · a run holds its truck until the truck's NEXT dispatch, not until the
 *     yard signs it back in (operator, 2026-11-23). The sign-in is kept as
 *     `returnedAt`, and vehicles/run-assignment writes the next run's start
 *     into `unassignedAt`, which also closed the runs that never came back.
 *     The 48 h cut-off those runs needed (RUN_OPEN_MAX_MS) is gone with them.
 *
 * Duty is not holding: scorecards count a driver's time up to the sign-in,
 * not the nights the truck stood in the yard under their name — see dutySpan.
 */
import { Prisma } from '../../../generated/prisma/client.js'

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
  return a.unassignedAt
}

/**
 * The span the driver was on DUTY: a run ends at its sign-in when there was
 * one, even though the truck stays under their name until the next dispatch.
 * Use this wherever time is charged to a driver (duty days, events at an
 * instant); use the assignment itself for "who holds the truck".
 */
export function dutySpan<T extends { unassignedAt: Date | null; returnedAt?: Date | null }>(a: T): T {
  const back = a.returnedAt
  if (!back || (a.unassignedAt && a.unassignedAt <= back)) return a
  return { ...a, unassignedAt: back }
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
 */
export function currentAssignmentWhere(now = new Date()): Prisma.VehicleAssignmentWhereInput {
  return {
    assignedAt: { lte: now },
    OR: [
      { unassignedAt: null },
      { unassignedAt: { gt: now } },
    ],
  }
}

/** Newest first: with `currentAssignmentWhere`, the first row is the one that holds the vehicle. */
export const CURRENT_ASSIGNMENT_ORDER = { assignedAt: 'desc' } as const
