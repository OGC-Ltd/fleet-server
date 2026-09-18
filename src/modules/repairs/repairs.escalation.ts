/**
 * "Escalate if unresolved after X days" — the rule, as a function of the rows.
 *
 * The walkthrough's last step is the one the Ops App never took: a job could
 * sit at `spare_outsourced` from September to Christmas and nothing in the
 * system would say so out loud. This is the part that notices. The sweep that
 * runs it lives in lib/queues; everything here is pure, because a rule about
 * when somebody gets telephoned has to be checkable in a test rather than
 * observed in production a fortnight late.
 *
 * ## Two clocks, because there are two ways to be late
 *
 * A job that has not moved in days and a job that has sailed past the date its
 * technician gave are different failures and need different words:
 *
 *   stalled  nothing has happened to it for `staleDays`. Measured from the
 *            last stage change, falling back to when it was filed. This is the
 *            one that catches a job nobody is working — the failure the
 *            walkthrough's closing sentence exists to prevent.
 *   overdue  it is `overdueDays` past `expectedResolutionAt`, the date the
 *            technician themself gave. The estimate was wrong or the part
 *            never came; either way somebody promised a day and it has gone.
 *
 * A job can be both. It is reported as OVERDUE, because that is the more
 * specific statement and it names a date somebody chose — "three days past the
 * 14th" is actionable in a way "quiet since the 9th" is not.
 *
 * ## Escalation repeats, but not daily
 *
 * The sweep runs every morning; a job escalated on Tuesday is still escalated
 * on Wednesday. Re-reporting it every morning is how an escalation feed becomes
 * something people filter out, so a job goes quiet again for `repeatDays` and
 * comes back one LEVEL higher. The level is what a reader sorts by: level 3 is
 * a job that has been escalated three times and is still open.
 *
 * ## Escalation is recorded on the ticket, not only sent
 *
 * The entries go on the item's `stageHistory` — the same trail a stage change
 * writes — carrying `kind: 'escalation'`. They do NOT change `stage`, and that
 * is deliberate: escalating a job does not stop the repair, and a ticket that
 * read "escalated" instead of "waiting for a part" would lose the fact anybody
 * chasing it needs. The stage says what the job is doing; the escalations say
 * who has been told about it.
 */

import type { StageEvent } from './repairs.repository.js'

export const DAY_MS = 86_400_000

/** Why a job was escalated. Ordered: `overdue` outranks `stalled`. */
export type EscalationReason = 'overdue' | 'stalled'

/** One escalation, as it goes onto the trail and into the message. */
export interface EscalationEvent {
  kind:   'escalation'
  reason: EscalationReason
  /** 1 on the first, 2 when it comes back, and so on. */
  level:  number
  at:     string
  /** Days late at the moment of escalating — the number the message quotes. */
  days:   number
  note?:  string
}

/** The fields the rule reads. Structural, so a Prisma row, a widened include
 *  or a fixture all satisfy it without importing anything from here. */
export interface EscalatableItem {
  id:                    string
  stage:                 string
  createdAt:             Date
  stageChangedAt:        Date | null
  expectedResolutionAt:  Date | null
  resolvedAt:            Date | null
  stageHistory?:         unknown
}

export interface EscalationPolicy {
  now:         Date
  /** No movement for this many days. */
  staleDays:   number
  /** Past the technician's own date by this many days. */
  overdueDays: number
  /** How long an escalated job stays quiet before it comes back a level up. */
  repeatDays:  number
}

/** The escalations already on a trail, oldest first. */
export function escalationsOf(history: unknown): EscalationEvent[] {
  if (!Array.isArray(history)) return []
  return (history as Array<StageEvent | EscalationEvent>)
    .filter((e): e is EscalationEvent =>
      Boolean(e) && (e as EscalationEvent).kind === 'escalation')
}

/** The most recent escalation on a trail, or null. */
export function lastEscalation(history: unknown): EscalationEvent | null {
  const all = escalationsOf(history)
  return all.length ? all[all.length - 1]! : null
}

const days = (ms: number) => Math.floor(ms / DAY_MS)

/**
 * Is this job due an escalation, and for which of the two reasons?
 *
 * Null for a job that is fine, a job already escalated inside the quiet
 * window, and — always — a job that is closed: a signed-off ticket has left
 * the loop the proper way and must never be chased.
 */
export function escalationDue(
  item: EscalatableItem,
  policy: EscalationPolicy,
): EscalationEvent | null {
  if (item.resolvedAt) return null

  const now = policy.now.getTime()

  /* The quiet window, before either clock is read: a job escalated yesterday is
     not escalated again today whatever the clocks say. */
  const last = lastEscalation(item.stageHistory)
  if (last) {
    const since = now - new Date(last.at).getTime()
    if (since < policy.repeatDays * DAY_MS) return null
  }
  const level = (last?.level ?? 0) + 1

  /* Overdue first — the more specific of the two, and the only one that names
     a date a person chose. `expectedResolutionAt` is a DATE at midnight UTC;
     the day it names is not late until it has ENDED, so the deadline is the
     end of that day plus the grace. */
  if (item.expectedResolutionAt) {
    const deadline = item.expectedResolutionAt.getTime() + DAY_MS + policy.overdueDays * DAY_MS
    if (now >= deadline) {
      return {
        kind: 'escalation',
        reason: 'overdue',
        level,
        at: policy.now.toISOString(),
        days: days(now - (item.expectedResolutionAt.getTime() + DAY_MS)),
      }
    }
  }

  /* Stalled: measured from the last movement. `stageChangedAt` is null only for
     rows filed before that column existed, and `createdAt` is the honest
     fallback — the job has certainly not moved since it was filed. */
  const movedAt = (item.stageChangedAt ?? item.createdAt).getTime()
  if (now - movedAt >= policy.staleDays * DAY_MS) {
    return {
      kind: 'escalation',
      reason: 'stalled',
      level,
      at: policy.now.toISOString(),
      days: days(now - movedAt),
    }
  }

  return null
}

/** The escalations due across a batch, in the order they should be reported:
 *  the worst first, so a truncated message keeps the jobs that matter. */
export function escalationsDue<T extends EscalatableItem>(
  items: T[],
  policy: EscalationPolicy,
): Array<{ item: T; event: EscalationEvent }> {
  const out: Array<{ item: T; event: EscalationEvent }> = []
  for (const item of items) {
    const event = escalationDue(item, policy)
    if (event) out.push({ item, event })
  }
  return out.sort((a, b) =>
    b.event.level - a.event.level ||
    b.event.days - a.event.days ||
    a.item.id.localeCompare(b.item.id))
}

/** "3 days past the estimate" / "quiet for 5 days" — the clause a message and
 *  a tracking line both need, written once so they cannot disagree. */
export function escalationPhrase(e: EscalationEvent): string {
  const d = `${e.days} day${e.days === 1 ? '' : 's'}`
  return e.reason === 'overdue'
    ? `${d} past the expected date`
    : `no movement for ${d}`
}
