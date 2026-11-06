/**
 * Feedback on a dashcam alarm (operator, 7 Nov 2026): a verdict and a note,
 * shared with everyone in the organisation, beside the alarm's details on the
 * Dashcam Alarms page. Each entry is kept; the alarm's verdict is the newest.
 *
 * The alarms themselves live on VSS, so an entry is keyed by the alarm's VSS
 * id and carries the unit and the time, enough to read it without VSS.
 */

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'

export const VERDICTS = ['genuine', 'false_alarm', 'coached'] as const
export type Verdict = (typeof VERDICTS)[number]

/** An alarm's VSS id, as the page holds it. */
export const ALARM_ID = /^[A-Za-z0-9_:.-]{1,120}$/

export const feedbackBodySchema = z.object({
  verdict: z.enum(VERDICTS),
  note: z.string().trim().max(1000).default(''),
  vehicleId: z.string().max(80).nullish(),
  plate: z.string().max(40).default(''),
  alarmAt: z.string().datetime({ offset: true }).nullish(),
}).strict()
export type FeedbackBody = z.infer<typeof feedbackBodySchema>

export interface FeedbackEntry {
  id: string
  verdict: Verdict
  note: string
  by: string
  at: string
}

const toEntry = (r: { id: string; verdict: string; note: string; authorName: string; createdAt: Date }): FeedbackEntry => ({
  id: r.id, verdict: r.verdict as Verdict, note: r.note, by: r.authorName, at: r.createdAt.toISOString(),
})

/** Every entry on one alarm, newest first. */
export async function feedbackFor(orgId: string, alarmId: string): Promise<FeedbackEntry[]> {
  const rows = await prisma.dashcamAlarmFeedback.findMany({
    where: { organisationId: orgId, alarmId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, verdict: true, note: true, authorName: true, createdAt: true },
  })
  return rows.map(toEntry)
}

/** One more entry on an alarm, by the user signed in. */
export async function addFeedback(
  orgId: string, alarmId: string, body: FeedbackBody, author: { id: string | null; name: string },
): Promise<FeedbackEntry> {
  const row = await prisma.dashcamAlarmFeedback.create({
    data: {
      organisationId: orgId, alarmId, verdict: body.verdict, note: body.note,
      vehicleId: body.vehicleId ?? null, plate: body.plate,
      alarmAt: body.alarmAt ? new Date(body.alarmAt) : null,
      authorId: author.id, authorName: author.name,
    },
    select: { id: true, verdict: true, note: true, authorName: true, createdAt: true },
  })
  return toEntry(row)
}
