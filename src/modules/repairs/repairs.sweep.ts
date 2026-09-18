/**
 * The daily pass over open repair jobs: escalate what is late, and say what is
 * still open.
 *
 * Two jobs in one pass because they read the same rows, and because they are
 * the two halves of one promise. Escalation fires when a job has been ignored
 * long enough to need somebody outside the loop; the digest fires whether or
 * not anything happened at all, which is the only report that can catch a
 * fleet where every job has quietly stopped moving.
 *
 * The RULE is in repairs.escalation.ts and is pure. This file is the part that
 * touches the database and the feed: it reads, applies the rule, writes the
 * escalation onto the trail, and reports. Kept apart so the rule can be tested
 * without a Postgres, which is the only way a threshold measured in days ever
 * gets tested at all.
 *
 * ## Why it writes before it reports
 *
 * The trail entry is what stops tomorrow's sweep escalating the same job again,
 * so it is written first and the notification follows. A crash between the two
 * loses a message and keeps the record; the other order would re-escalate every
 * morning until the write succeeded, which is the failure that trains people to
 * ignore the feed.
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import {
  escalationDue, escalationsOf, lastEscalation, DAY_MS,
  type EscalationEvent,
} from './repairs.escalation.js'
import { escalationRecipients, reportEscalation, reportOpenDigest } from './repairs.notify.js'
import { humanKind, repairRecipients } from './repairs.service.js'

/** What the sweep did, for the job's return value and the log line. */
export interface SweepResult {
  scanned:   number
  escalated: number
  orgs:      number
}

/** The policy, read once per run so every row in a pass is judged by the same
 *  numbers and the same clock. */
function policy(now: Date) {
  return {
    now,
    staleDays:   env.REPAIR_ESCALATE_STALE_DAYS,
    overdueDays: env.REPAIR_ESCALATE_OVERDUE_DAYS,
    repeatDays:  env.REPAIR_ESCALATE_REPEAT_DAYS,
  }
}

/** Append an escalation to the trail, leaving `stage` alone.
 *
 *  `updateMany` with `resolvedAt: null` in the WHERE, like every other write in
 *  this module: a job signed off between the read and this write must not have
 *  an escalation appended to it — the ticket left the loop the proper way and
 *  chasing it afterwards is exactly the noise this feature is meant to remove. */
async function recordEscalation(itemId: string, history: unknown, event: EscalationEvent): Promise<boolean> {
  const prior = Array.isArray(history) ? history : []
  const { count } = await prisma.repairReportItem.updateMany({
    where: { id: itemId, resolvedAt: null },
    data:  { stageHistory: [...prior, event].slice(-200) as object[] },
  })
  return count > 0
}

/**
 * One pass.
 *
 * Every organisation, in one query: the sweep is a cron over a table that holds
 * a few hundred open rows across the platform, and paging it per tenant would
 * be five round trips to a pooler for a job that runs once a day.
 */
export async function runRepairSweep(now = new Date()): Promise<SweepResult> {
  const open = await prisma.repairReportItem.findMany({
    where:  { resolvedAt: null },
    select: {
      id: true, organisationId: true, stage: true, createdAt: true,
      stageChangedAt: true, expectedResolutionAt: true, resolvedAt: true,
      stageHistory: true, faultKind: true,
      vehicle: { select: { registrationPlate: true } },
    },
    // Oldest first: if a run is cut short, the jobs that have waited longest
    // are the ones that got their message.
    orderBy: { createdAt: 'asc' },
  })

  const pol = policy(now)
  const fallback = repairRecipients()
  const to = escalationRecipients(fallback)

  let escalated = 0
  /** Per org, for the digest below: counted from the same rows the escalation
   *  ran on, so the digest cannot disagree with the messages beside it. */
  const byOrg = new Map<string, { open: number; awaitingSpare: number; overdue: number; escalated: number }>()

  for (const item of open) {
    const tally = byOrg.get(item.organisationId)
      ?? { open: 0, awaitingSpare: 0, overdue: 0, escalated: 0 }
    tally.open += 1
    if (item.stage === 'spare_outsourced') tally.awaitingSpare += 1
    if (item.expectedResolutionAt && now.getTime() >= item.expectedResolutionAt.getTime() + DAY_MS) {
      tally.overdue += 1
    }
    if (escalationsOf(item.stageHistory).length > 0) tally.escalated += 1
    byOrg.set(item.organisationId, tally)

    const event = escalationDue(item, pol)
    if (!event) continue

    const written = await recordEscalation(item.id, item.stageHistory, event)
    if (!written) continue
    escalated += 1
    // Counted in the digest as well: it was escalated in this very pass, and a
    // digest that said "0 escalated" beside three escalation items would be the
    // two halves of one pass disagreeing.
    if (!lastEscalation(item.stageHistory)) tally.escalated += 1

    await reportEscalation(
      {
        itemId: item.id,
        orgId:  item.organisationId,
        plate:  item.vehicle.registrationPlate,
        label:  humanKind(item.faultKind),
      },
      event,
      to,
    )
  }

  for (const [orgId, counts] of byOrg) {
    await reportOpenDigest(orgId, counts, now)
  }

  const result: SweepResult = { scanned: open.length, escalated, orgs: byOrg.size }
  logger.info({ ...result, ...policy(now), now: now.toISOString() }, 'repair sweep: done')
  return result
}
