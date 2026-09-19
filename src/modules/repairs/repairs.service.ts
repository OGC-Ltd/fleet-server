import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { sendMail } from '../../lib/mailer/mailer.js'
import { repairReportEmail } from '../../lib/mailer/templates.js'
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import { prisma } from '../../lib/prisma.js'
import * as repo from './repairs.repository.js'
import { reportResolution, reportStageChange } from './repairs.notify.js'
import { notifyRepairAssignment } from './repairs.assignment-mail.js'
import { chooseTechnicianForTriage } from './repairs.triage.js'
import type { AssignRepairItem, CreateRepairReport, ResolveItem, SetStage, RespondToAssignment } from './repairs.schema.js'

export { notifyRepairAssignment }

/**
 * What became of the mail, in enough detail to say so on screen.
 *
 * This type exists because "filed" and "the handlers were told" are different
 * facts and the dashboard must not conflate them. The box carries no MAILTRAP
 * keys today, so `unconfigured` is the CURRENT production answer, not an edge
 * case — a tick shown against it would be a lie the technician acts on.
 */
export type EmailOutcome = {
  status:     'sent' | 'partial' | 'failed' | 'unconfigured' | 'no-recipients'
  recipients: string[]
  sent:       string[]
  failed:     string[]
}

/**
 * The handlers, from ONE list in env config.
 *
 * Deliberately not per-organisation: the people who order probe spares are one
 * team across every tenant, and a per-org table would be a second place to
 * keep a list that has one true value. Revisit when a second team appears.
 */
export function repairRecipients(): string[] {
  return [...new Set(
    env.REPAIR_NOTIFY_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  )]
}

const OUTCOME_LABEL: Record<string, string> = {
  fixing:      'Fixing',
  needs_spare: 'Needs a spare part',
  cannot_fix:  'Cannot be fixed',
}

/** The ladder, for anything on this side that has to name a stage. */
const STAGE_LABEL: Record<string, string> = {
  pending:          'Pending',
  spare_outsourced: 'Spare outsourced',
  fixing:           'Fixing',
  fixed:            'Fixed',
  // The stored value stays 'failed'. Unlike fixed/fixing — which had to be
  // renamed because they mean different things — these two are the same word,
  // so the label can read the way people say it without the column drifting
  // from what it holds.
  failed:           'Unsuccessful',
}

/** `fuel_probe_dead` -> `Fuel probe dead`. The episode kinds are snake_case. */
function humanKind(kind: string | null | undefined): string {
  if (!kind) return 'Probe health'
  const s = kind.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

type ReportWithItems = Awaited<ReturnType<typeof repo.createReport>>

export async function notifyRepairReport(
  report: ReportWithItems,
  orgName: string,
  technicianName: string,
): Promise<EmailOutcome> {
  const recipients = repairRecipients()
  if (recipients.length === 0) {
    logger.warn({ reportId: report.id }, 'repair report: no recipients configured — nothing sent')
    return { status: 'no-recipients', recipients: [], sent: [], failed: [] }
  }

  const mail = repairReportEmail({
    orgName,
    technicianName,
    reportedAt: report.reportedAt,
    ...(report.note ? { note: report.note } : {}),
    ...(env.APP_BASE_URL ? { link: env.APP_BASE_URL } : {}),
    items: report.items.map((i) => ({
      plate:   i.vehicle.registrationPlate,
      label:   humanKind(i.faultKind),
      outcome: i.outcome as 'fixing' | 'needs_spare' | 'cannot_fix',
      ...(i.sparePart   ? { sparePart:   i.sparePart }   : {}),
      ...(i.problemNote ? { problemNote: i.problemNote } : {}),
      ...(i.expectedResolutionAt ? { expectedResolutionAt: i.expectedResolutionAt } : {}),
    })),
  })

  /*
   * sendMail takes ONE recipient and, by its own documented contract, cannot
   * reject — it resolves `{ sent: false }` instead. That is what makes
   * Promise.all safe here rather than a footgun: no single bad address can
   * reject the lot and lose the outcome of the addresses that worked.
   */
  const results = await Promise.all(recipients.map((addr) => sendMail(addr, null, mail)))
  const sent   = recipients.filter((_, i) => results[i]!.sent)
  const failed = recipients.filter((_, i) => !results[i]!.sent)

  const status: EmailOutcome['status'] =
    sent.length === recipients.length ? 'sent'
      : sent.length > 0 ? 'partial'
        : results.every((r) => !r.sent && r.reason === 'unconfigured') ? 'unconfigured'
          : 'failed'

  return { status, recipients, sent, failed }
}

export async function submitRepairReport(orgId: string, userId: string, dto: CreateRepairReport) {
  await repo.assertTargetsInOrg(orgId, dto.items)

  const report = await repo.createReport(orgId, userId, dto)

  const org = await prisma.organisation.findUnique({
    where: { id: orgId }, select: { name: true },
  })
  const orgName = org?.name ?? 'Fleet'
  const technicianName = report.reportedBy?.fullName ?? 'A technician'

  /*
   * The mail goes AFTER the transaction has committed, never inside it.
   * Mailtrap is bounded at ten seconds by the client's own timeout, and
   * holding a Postgres transaction open across an SMTP round trip is a row
   * lock held hostage to a third party's latency.
   */
  const email = await notifyRepairReport(report, orgName, technicianName)

  /*
   * Recording the outcome is a best-effort follow-up. If THIS throws, the
   * report exists and the mail has gone, and failing the request would invite
   * a retry that files the whole thing a second time — which is precisely the
   * duplicate the open-target index exists to prevent, arriving by the one
   * route that index cannot see.
   */
  try {
    await repo.setEmailOutcome(report.id, email.status, {
      recipients: email.recipients, sent: email.sent, failed: email.failed,
    })
  } catch (err) {
    logger.error({ err, reportId: report.id }, 'repair report: could not record the email outcome')
  }

  /*
   * A feed item alongside the mail, and not a nicety: the notification store
   * works in production today and the mailer does not, so until the MAILTRAP
   * keys land this is the ONLY path by which anyone downstream learns that a
   * spare part is needed.
   */
  const spares  = report.items.filter((i) => i.outcome === 'needs_spare').length
  const blocked = report.items.filter((i) => i.outcome === 'cannot_fix').length
  const parts = [`${report.items.length} unit${report.items.length === 1 ? '' : 's'}`]
  if (spares)  parts.push(`${spares} need${spares === 1 ? 's' : ''} spares`)
  if (blocked) parts.push(`${blocked} cannot be fixed`)

  try {
    await publishNotificationDurable({
      orgId,
      id:        `repair-${report.id}`,
      source:    'repair',
      alertType: 'repair_report',
      severity:  spares > 0 || blocked > 0 ? 'warning' : 'info',
      text:      `Repair report: ${parts.join(' · ')} — ${technicianName}`,
      at:        report.reportedAt,
    })
  } catch (err) {
    logger.error({ err, reportId: report.id }, 'repair report: could not publish the feed item')
  }

  return { report, email }
}

/**
 * Move an open job, and tell somebody.
 *
 * The controller used to call the repository straight, which is how a ticket
 * could change hands with nobody hearing about it — see the note at the top of
 * repairs.notify.ts. The move and the message are one call now, and the
 * message is best-effort: a notification that fails must never undo a stage
 * change a technician has already been shown.
 */
export async function changeStage(itemId: string, orgId: string, userId: string, dto: SetStage) {
  const result = await repo.setStage(itemId, orgId, userId, dto)
  if (!result.item) return result

  const item = result.item as typeof result.item & {
    vehicle?: { registrationPlate?: string }
    faultKind?: string | null
    stageChangedAt?: Date | null
  }
  await reportStageChange(
    {
      itemId,
      orgId,
      plate: item.vehicle?.registrationPlate ?? 'Unknown unit',
      label: humanKind(item.faultKind),
    },
    dto.stage,
    await actorName(userId),
    item.stageChangedAt ?? new Date(),
    dto.note,
  )
  return result
}

export async function assignItemToTechnician(itemId: string, orgId: string, userId: string, dto: AssignRepairItem) {
  let technicianId = dto.technicianId

  if (!technicianId) {
    const technicians = await prisma.user.findMany({
      where: { organisationId: orgId },
      select: { id: true, fullName: true },
    })
    const openItems = await prisma.repairReportItem.findMany({
      where: { organisationId: orgId, resolvedAt: null },
      select: { id: true, assignedToId: true },
    })
    technicianId = chooseTechnicianForTriage(technicians, openItems, userId) ?? undefined
  }

  const result = await repo.assignItem(itemId, orgId, userId, {
    technicianId,
    reason: dto.reason ?? (technicianId ? 'Assigned by triage' : undefined),
  })
  if (!result.item) return result

  const assignmentEmail = await notifyRepairAssignment({
    itemId,
    orgId,
    assignedById: userId,
    assignedToId: technicianId ?? userId,
    reason: dto.reason ?? (technicianId ? 'Assigned by triage' : undefined),
  })

  const item = result.item as typeof result.item & {
    vehicle?: { registrationPlate?: string }
    faultKind?: string | null
    assignedToId?: string | null
    assignedTo?: { fullName?: string | null } | null
  }

  const actor = await actorName(userId)
  const assignee = item.assignedTo?.fullName ?? 'Unassigned'
  await reportStageChange(
    {
      itemId,
      orgId,
      plate: item.vehicle?.registrationPlate ?? 'Unknown unit',
      label: humanKind(item.faultKind),
    },
    item.stage,
    actor,
    item.stageChangedAt ?? new Date(),
    dto.reason ? `Assigned to ${assignee} — ${dto.reason}` : `Assigned to ${assignee}`,
  )

  return { ...result, assignmentEmail }
}

export async function autoAssignTechnician(orgId: string, itemId: string, userId: string, reason?: string) {
  return assignItemToTechnician(itemId, orgId, userId, {
    reason: reason ?? 'Auto-assigned by triage',
  })
}

export async function respondToAssignment(
  itemId: string, orgId: string, userId: string, dto: RespondToAssignment,
) {
  return repo.respondToAssignment(itemId, orgId, userId, dto.status)
}

/**
 * Sign a job off, and tell somebody.
 *
 * The one closure that leaves the building is the unsuccessful one: a unit that
 * cannot be fixed here is a decision for somebody who does not read the Repairs
 * tab, so `reportResolution` mails that half and only that half.
 */
export async function closeItem(itemId: string, orgId: string, userId: string, dto: ResolveItem) {
  const item = await repo.resolveItem(itemId, orgId, userId, dto)
  if (!item) return null

  const withVehicle = item as typeof item & {
    vehicle?: { registrationPlate?: string }
    faultKind?: string | null
    resolvedAt?: Date | null
  }
  await reportResolution(
    {
      itemId,
      orgId,
      plate: withVehicle.vehicle?.registrationPlate ?? 'Unknown unit',
      label: humanKind(withVehicle.faultKind),
    },
    dto.verdict,
    await actorName(userId),
    withVehicle.resolvedAt ?? new Date(),
    dto.fixNote ?? '',
    repairRecipients(),
  )
  return item
}

/** Who did it, for the message. The trail on the row already carries the id;
 *  a feed item that said "moved by cmr6da1bp0000" would be a message nobody
 *  can read. */
async function actorName(userId: string): Promise<string> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
    return u?.fullName ?? 'A technician'
  } catch {
    return 'A technician'
  }
}

export { OUTCOME_LABEL, STAGE_LABEL, humanKind }
