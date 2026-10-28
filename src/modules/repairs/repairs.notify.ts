/**
 * Every ticket event, reported once, from one place.
 *
 * ## Why this file exists
 *
 * The walkthrough ends on a promise: *nothing leaves the loop silently — a
 * ticket is either closed in the Ops App or escalated.* Until this file, the
 * Ops App kept half of it. Filing a report mailed the handlers and wrote a feed
 * item; everything after that — the move to "fixing", the part arriving, the
 * sign-off, the job that sat untouched for a fortnight — changed a row and told
 * nobody. A reader who did not open the Repairs tab had no way to learn that a
 * job had moved, and no way at all to learn that one had not.
 *
 * So the reporting is a seam rather than a habit: the service calls it on every
 * transition, and a future caller that moves a ticket without coming through
 * here is a caller that has to work at going quiet.
 *
 * ## Two channels
 *
 * Every event below writes a feed item. The two that leave the building — a
 * job that cannot be fixed, and an escalation — also reach the handlers
 * directly, by Web Push (they were mailed until 2026-10-28).
 *
 * ## Failures here never fail the write
 *
 * A stage change that succeeded and a notification that did not is a ticket
 * that moved and a message that was lost; a stage change rolled back because
 * Redis hiccuped is a technician told their work did not save. The first is
 * recoverable from the trail on the row, the second is not, so every call here
 * is wrapped and logged rather than thrown.
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import { enqueueNotification } from '../../lib/queues/outbound.js'
import { pushService } from '../notifications/notifications.service.js'
import { escalationPhrase, type EscalationEvent } from './repairs.escalation.js'
import { STAGE_LABEL } from './repairs.service.js'

/** Who hears about an escalation. Its own list, because "the people who order
 *  spares" and "the people who need to know an order never arrived" are not
 *  the same desk — see §7 of docs/tech-resolution-process.md. Falls back to the
 *  repair handlers rather than to nobody: a list left unset must not silently
 *  turn escalation off. */
export function escalationRecipients(fallback: string[]): string[] {
  const own = env.REPAIR_ESCALATION_EMAILS
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return own.length ? [...new Set(own)] : fallback
}

/** What a notification is about, in the words the feed uses. */
type Level = 'info' | 'warning' | 'critical'

interface TicketRef {
  itemId: string
  orgId:  string
  plate:  string
  /** What the technician was sent out for, already humanised. */
  label:  string
}

/** One feed item, never throwing. The id is deterministic per event so a retry
 *  of the same transition updates the row rather than filing a second one. */
async function feed(
  ref: TicketRef, id: string, alertType: string, severity: Level, text: string, at: Date,
): Promise<void> {
  try {
    // Queued when there is a Redis, written inline when there is not. Either
    // way this no longer holds an HTTP handler open for a pooler round trip,
    // which on this connection is about a second per item and there are two
    // per sign-off.
    await enqueueNotification({
      orgId: ref.orgId, id, source: 'repair', alertType, severity, text, at,
    })
  } catch (err) {
    logger.error({ err, itemId: ref.itemId, alertType }, 'repair: could not publish the feed item')
  }
}

/** Web Push to the accounts behind a list of addresses, never throwing.
 *  `failed` is the addresses with no account, which have no devices. */
async function push(
  ref: TicketRef, to: string[], tag: string, title: string, body: string,
): Promise<{ sent: string[]; failed: string[] }> {
  if (to.length === 0) return { sent: [], failed: [] }
  try {
    const { ids, unmatched } = await pushService.usersForEmails(to)
    await pushService.sendToUsers(ids, {
      title, body, tag, icon: '/logo-icon.png',
      data: { url: '/', orgId: ref.orgId, itemId: ref.itemId },
    })
    return { sent: to.filter((a) => !unmatched.includes(a)), failed: unmatched }
  } catch (err) {
    logger.error({ err, tag }, 'repair: could not send the push notification')
    return { sent: [], failed: to }
  }
}

/**
 * A job moved along the ladder.
 *
 * `warning` for the two stages that mean somebody else now has to act — a part
 * to order, a repair that has stopped — and `info` for the rest. The severity
 * is what decides whether the item interrupts anybody, so a job merely
 * progressing must not use the same level as one that has stuck.
 */
export async function reportStageChange(
  ref: TicketRef, stage: string, byName: string, at: Date, note?: string,
): Promise<void> {
  const severity: Level = stage === 'spare_outsourced' || stage === 'failed' ? 'warning' : 'info'
  const label = STAGE_LABEL[stage] ?? stage
  await feed(
    ref,
    // Per stage, not per move: a job that goes fixing → spare → fixing files
    // two items, and the second `fixing` replaces the first. That is the right
    // trade for a feed — the trail on the row is what keeps every move.
    `repair-stage-${ref.itemId}-${stage}`,
    'repair_stage',
    severity,
    `${ref.plate} · ${ref.label}: ${label}${note ? ` — ${note}` : ''} (${byName})`,
    at,
  )
}

/**
 * A job was signed off.
 *
 * The unsuccessful half also pushes to the handlers (it mailed until
 * 2026-10-28), because "this unit cannot be fixed here" is the one closure
 * that needs somebody outside the Repairs tab to decide what happens to the
 * machine.
 */
export async function reportResolution(
  ref: TicketRef,
  verdict: 'fixed' | 'failed',
  byName: string,
  at: Date,
  fixNote: string,
  recipients: string[],
): Promise<void> {
  const ok = verdict === 'fixed'
  await feed(
    ref,
    `repair-closed-${ref.itemId}`,
    'repair_closed',
    ok ? 'info' : 'warning',
    ok
      ? `${ref.plate} · ${ref.label}: fixed by ${byName} — ${fixNote}`
      : `${ref.plate} · ${ref.label}: could not be fixed (${byName}) — ${fixNote}`,
    at,
  )
  if (ok) return

  const { sent, failed } = await push(
    ref, recipients, `repair-closed-${ref.itemId}`,
    `Unit could not be fixed: ${ref.plate}`,
    `${ref.label} — signed off unsuccessfully by ${byName}${fixNote ? `: ${fixNote}` : ''}`,
  )
  if (failed.length) {
    logger.warn({ itemId: ref.itemId, sent, failed }, 'repair: unsuccessful sign-off not pushed to everyone')
  }
}

/**
 * A job passed a threshold with nobody having closed it.
 *
 * This is the message the walkthrough's last step asks for, and the only one in
 * this file that fires when NOTHING happened — which is exactly the case that
 * used to go unreported. Severity climbs with the level so a third escalation
 * does not arrive looking like the first.
 */
export async function reportEscalation(
  ref: TicketRef, event: EscalationEvent, recipients: string[],
): Promise<void> {
  const at = new Date(event.at)
  const phrase = escalationPhrase(event)
  await feed(
    ref,
    // Per LEVEL: the same job escalating a second time is a second item, and
    // the first stays on the feed as the record that it was already raised.
    `repair-escalation-${ref.itemId}-${event.level}`,
    'repair_escalated',
    event.level >= 2 ? 'critical' : 'warning',
    `Escalated (level ${event.level}): ${ref.plate} · ${ref.label} — ${phrase}`,
    at,
  )

  const { sent, failed } = await push(
    ref, recipients, `repair-escalation-${ref.itemId}-${event.level}`,
    `Escalation (level ${event.level}): ${ref.plate}`,
    `${ref.label} — ${phrase}. The job is still open and has not been closed.`,
  )
  if (failed.length) {
    logger.warn({ itemId: ref.itemId, level: event.level, sent, failed }, 'repair: escalation not pushed to everyone')
  }
}

/**
 * What is still open, once a day.
 *
 * The only report here that is not a transition, and the one that makes the
 * walkthrough's closing sentence true: every other message fires because
 * something moved, and a ticket nobody touches is precisely the ticket that
 * produces none of them. One line a day, per organisation, whether or not
 * anything happened.
 *
 * Silent when there is nothing open. A daily "0 jobs open" is a message people
 * learn to skip, and skipping it is how the day it says 14 gets skipped too.
 */
export async function reportOpenDigest(
  orgId: string,
  counts: { open: number; awaitingSpare: number; overdue: number; escalated: number },
  at: Date,
): Promise<void> {
  if (counts.open === 0) return
  const parts = [`${counts.open} open`]
  if (counts.awaitingSpare) parts.push(`${counts.awaitingSpare} waiting on a part`)
  if (counts.overdue)       parts.push(`${counts.overdue} past its date`)
  if (counts.escalated)     parts.push(`${counts.escalated} escalated`)

  try {
    await publishNotificationDurable({
      orgId,
      // One per org per day: a second run on the same day updates it rather
      // than stacking a duplicate under it.
      id:        `repair-digest-${orgId}-${at.toISOString().slice(0, 10)}`,
      source:    'repair',
      alertType: 'repair_digest',
      severity:  counts.escalated > 0 || counts.overdue > 0 ? 'warning' : 'info',
      text:      `Repair jobs: ${parts.join(' · ')}`,
      at,
    })
  } catch (err) {
    logger.error({ err, orgId }, 'repair: could not publish the daily digest')
  }
}
