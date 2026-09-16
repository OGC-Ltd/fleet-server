/**
 * The stage a job is ACTUALLY at, once the calendar is taken into account.
 *
 * ## The one transition nobody should have to click
 *
 * A job filed as "needs a spare part" lands on `spare_outsourced` and carries
 * the technician's fix date — the day they expect the part to land and the
 * work to start. On that day the job IS being fixed. Making somebody open the
 * Repairs tab and press "Fixing" to say so is asking them to hand-copy a fact
 * the row already holds, and the press is the kind of bookkeeping that quietly
 * stops happening: the jobs that most need chasing are exactly the ones nobody
 * is opening the tab for.
 *
 * So the step is automatic. It is the last one that can be, and deliberately
 * the ONLY one: `fixed` and `failed` are claims a person has to stand behind
 * and a date can never assert either.
 *
 * ## Derived, not swept
 *
 * There is no scheduler that could do this. The repeatable-job machinery is
 * BullMQ (see lib/queues/retention.ts) and it is inert without Redis, which
 * this deployment has none of — a sweep written there would simply never run
 * in production. A `setInterval` would run once per instance and lose every
 * transition the process slept through.
 *
 * Deriving it sidesteps all of that. There is no run to miss, no catch-up to
 * get right, no write on a read path, and the answer is correct the instant
 * the date passes rather than at the next tick. What Postgres stores is what
 * was FILED — the stage a person put it in, and the date they gave — and this
 * is the reading of those two facts. The same split `accountState` makes on
 * the dashboard, for the same reason: one column cannot answer a question that
 * depends on today.
 *
 * The cost is that `stage` in the database disagrees with `stage` on the wire
 * for a job whose date has passed. That is paid for here, in one place, and
 * every read goes through it — so nothing downstream has to know, and the
 * `?stage=` filter is translated to match (see `stageFilter`).
 */

import type { Stage } from './repairs.schema.js'

/** Where the automatic step starts, and where it lands. */
export const AUTO_FROM: Stage = 'spare_outsourced'
export const AUTO_TO:   Stage = 'fixing'

/** Midnight UTC today — the same frame `expected_resolution_at` is stored in. */
function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** The minimum shape this reasoning needs. Structural so it accepts a Prisma
 *  row, an include-widened row, or a test fixture, without any of them
 *  importing a type from here. */
export interface StageBearing {
  stage:                 string
  resolvedAt:            Date | null
  expectedResolutionAt:  Date | null
  stageHistory?:         unknown
  /** Declared because `withEffectiveStage` WRITES it — an interface that only
   *  covered the reads would let the write drift away from the column. */
  stageChangedAt?:       Date | null
}

/**
 * Has this job's fix date arrived?
 *
 * Three guards, and each closes a different wrong answer:
 *
 *   resolvedAt      a signed-off job is finished. Advancing one would walk a
 *                   closed job back onto the ladder, and Postgres forbids the
 *                   result anyway (resolved ⇒ stage IN (fixed, failed)).
 *   stage           only the waiting rung advances. A job somebody has already
 *                   moved to `fixing` by hand is there; one at `failed` is
 *                   open for somebody with more kit and is not "being fixed".
 *   a date at all   `spare_outsourced` can also be reached by hand from the
 *                   stage buttons, and that path has no date. No date, no
 *                   automatic step — silence is not a deadline.
 *
 * The comparison is `<=`, so the step happens ON the fix date rather than the
 * day after. The technician said the part lands that day; the job is under way
 * that day.
 */
export function isAutoAdvanced(item: StageBearing, now: Date = new Date()): boolean {
  if (item.resolvedAt !== null) return false
  if (item.stage !== AUTO_FROM) return false
  if (item.expectedResolutionAt === null) return false
  return item.expectedResolutionAt.getTime() <= utcToday(now).getTime()
}

/**
 * One item as the API should describe it.
 *
 * Returns the row untouched unless the date has arrived, in which case the
 * stage moves AND a matching entry is appended to the history — because a
 * tracking line reading "Fixing" with no date under it looks like a rung that
 * was skipped rather than one that was reached. The entry is synthesised, not
 * stored: it carries no `by`, since nobody did it, and `auto: true` so the
 * dashboard can say so rather than implying a person pressed something.
 *
 * `stageChangedAt` moves to the fix date too. "Stuck for three weeks" is read
 * off that column, and leaving it on the day the part was ordered would age
 * the job from the wrong event.
 */
export function withEffectiveStage<T extends StageBearing>(item: T, now: Date = new Date()): T {
  if (!isAutoAdvanced(item, now)) return item

  const at = item.expectedResolutionAt as Date
  const history = Array.isArray(item.stageHistory) ? item.stageHistory : []

  return {
    ...item,
    stage:          AUTO_TO,
    stageChangedAt: at,
    stageHistory: [
      ...history,
      {
        stage: AUTO_TO,
        at:    at.toISOString(),
        by:    null,
        auto:  true,
        note:  'The part was expected on this date, so the job moved to Fixing on its own.',
      },
    ],
  }
}

/** The same, for a list. */
export function withEffectiveStages<T extends StageBearing>(items: T[], now: Date = new Date()): T[] {
  return items.map((i) => withEffectiveStage(i, now))
}

/**
 * Translate a `?stage=` filter so it selects what a reader would SEE.
 *
 * Without this the tab lies in both directions: filtering to Fixing would hide
 * the jobs that reached it by date — the ones that got there without anybody
 * looking, which are precisely the ones worth listing — and filtering to Spare
 * outsourced would show jobs the same screen is drawing as Fixing.
 *
 * Both branches stay index-backed: the partial index on
 * (organisation_id, expected_resolution_at) covers the date half and
 * (organisation_id, stage) covers the other.
 */
export function stageFilter(stage: Stage, now: Date = new Date()): Record<string, unknown> {
  const today = utcToday(now)

  if (stage === AUTO_TO) {
    return {
      OR: [
        { stage: AUTO_TO },
        { stage: AUTO_FROM, resolvedAt: null, expectedResolutionAt: { lte: today } },
      ],
    }
  }

  if (stage === AUTO_FROM) {
    // Still waiting: no date, or a date still ahead of itself.
    return {
      stage: AUTO_FROM,
      OR: [
        { expectedResolutionAt: null },
        { expectedResolutionAt: { gt: today } },
      ],
    }
  }

  return { stage }
}
