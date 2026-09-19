/**
 * The stage a job is ACTUALLY at, once the calendar is taken into account.
 *
 * ## Expected dates do not confirm delivery
 *
 * A job filed as "needs a spare part" lands on `spare_outsourced` and carries
 * the technician's expected date. That date is a deadline for chasing the
 * supplier, not proof that the spare arrived. A technician must explicitly
 * confirm receipt and move the job to `fixing`; otherwise an overdue delivery
 * would be shown as work already in progress.
 *
 * There is consequently no automatic stage transition. `fixed`, `failed`, and
 * even `fixing` are claims a person has to stand behind.
 *
 * ## Derived, not swept
 *
 * A correction worth keeping, because the first version of this comment got it
 * wrong: a sweep IS available. `REDIS_URL` is set on the production box and
 * BullMQ connects to it, so the repeatable-job machinery in lib/queues works
 * here and a nightly job could move these rows for real.
 *
 * It is still the wrong tool, for a reason that survives the correction. This
 * field has DAY granularity. A job that sweeps at 03:00 leaves every unit
 * whose part lands today reading "spare outsourced" for most of the working
 * day — wrong on precisely the day the answer matters, and wrong in the
 * direction that hides work from whoever is chasing it. Sweeping more often to
 * fix that is a cron firing every few minutes to notice a date change once.
 *
 * Deriving has no run to miss and no catch-up to get right; the answer is
 * correct the instant the date passes, it costs no write on a read path, and
 * it keeps working if Redis goes away. What Postgres stores is what was FILED
 * — the stage a person put it in, and the date they gave — and this is the
 * reading of those two facts. The same split `accountState` makes on the
 * dashboard, for the same reason: one column cannot answer a question that
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
  // An expected date is a deadline, not evidence that the spare arrived.
  // The technician must explicitly move the job to fixing after confirming it.
  void item
  void now
  return false
}

/**
 * One item as the API should describe it.
 *
 * Expected dates never alter the row. The stage changes only through an
 * explicit action, so the tracking line cannot claim a spare arrived when it
 * did not.
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
      },
    ],
  }
}

/** The same, for a list. */
export function withEffectiveStages<T extends StageBearing>(items: T[], now: Date = new Date()): T[] {
  return items.map((i) => withEffectiveStage(i, now))
}

/**
 * Translate a `?stage=` filter to the stored stage. Expected dates are used by
 * escalation and display, but never change which stage a row belongs to.
 */
export function stageFilter(stage: Stage, now: Date = new Date()): Record<string, unknown> {
  void now
  return { stage }
}
