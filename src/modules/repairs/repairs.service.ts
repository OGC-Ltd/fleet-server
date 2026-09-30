import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { sendMail } from '../../lib/mailer/mailer.js'
import { repairReportEmail } from '../../lib/mailer/templates.js'
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import { enqueueMail, dispatchStatus, isAccepted } from '../../lib/queues/outbound.js'
import { prisma } from '../../lib/prisma.js'
import * as repo from './repairs.repository.js'
import { reportResolution, reportStageChange } from './repairs.notify.js'
import { notifyRepairAssignment } from './repairs.assignment-mail.js'
import { canAssignTriage, canReceiveTriage, canSignOffTriage } from './repairs.authz.js'
import { ForbiddenError } from '../../core/errors/errors.js'
import { repairSignedOff } from '../fuel/fuel-followup.service.js'
import { assertNoOutstandingParts } from './repairs.overhaul.js'
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
  /**
   * `queued` is accepted by BullMQ and not yet offered to the provider. It is
   * deliberately not a kind of `sent`: the dashboard prints this word, and the
   * standing rule in lib/mailer is that a tick is never shown for a mail that
   * has not left the building.
   */
  status:     'sent' | 'queued' | 'partial' | 'failed' | 'unconfigured' | 'no-recipients'
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
  audit:       'Raised by Fuel Audit',
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
   * enqueueMail takes ONE recipient and, like the sendMail it wraps, cannot
   * reject — it resolves an outcome instead. That is what makes Promise.all
   * safe here rather than a footgun: no single bad address can reject the lot
   * and lose the outcome of the addresses that worked.
   *
   * With Redis this costs N `add` calls and returns; without it, it is the
   * inline send it always was. Either way the fan-out keeps its shape, so the
   * fold below did not have to change — only to learn one more word.
   */
  const results = await Promise.all(recipients.map((addr) => enqueueMail(addr, null, mail)))
  const sent   = recipients.filter((_, i) => isAccepted(results[i]!))
  const failed = recipients.filter((_, i) => !isAccepted(results[i]!))

  const status: EmailOutcome['status'] =
    // QUEUED IS ITS OWN ANSWER, consulted before the others. Folding it into
    // `sent` would print a tick for a mail still sitting in Redis, which is the
    // one thing this type exists to prevent; folding it into `failed` would
    // send somebody chasing a mail that is simply in flight.
    results.every((r) => dispatchStatus(r) === 'queued') ? 'queued'
      : sent.length === recipients.length ? 'sent'
        : sent.length > 0 ? 'partial'
          : results.every((r) => dispatchStatus(r) === 'unconfigured') ? 'unconfigured'
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

/**
 * Hand a triage to a named person, or take it back.
 *
 * ## There is no automatic triage any more
 *
 * This used to accept a MISSING `technicianId` as "you pick", and answer it by
 * listing every user in the organisation, counting their open items and
 * choosing the least loaded. Two things were wrong with that, and neither is
 * fixed by a better rule.
 *
 * It picked from EVERYBODY. The candidate list was `user.findMany({ where: {
 * organisationId } })` with no role filter at all, so on a tenant whose roster
 * is mostly drivers synced from the registry, "least loaded" is a near
 * guarantee of landing on somebody who has never signed in — they hold no open
 * items, so they sort first. The load-balancing was working perfectly and the
 * answer was still wrong.
 *
 * And it attributed a decision to nobody. `assignedById` recorded the person
 * who clicked, the trail read "Assigned by triage", and the assignee got an
 * email naming them as responsible for a unit — with no human anywhere in that
 * chain having chosen them. Work is given to a person BY a person; that is the
 * record the sign-off trail exists to keep.
 *
 * So `technicianId` is now required. `null` still means unassign, which is a
 * decision somebody makes and not an absence of one.
 *
 * ## Both ends are checked
 *
 * See repairs.authz: an administrator hands out, a TECHNICIAN receives, and the
 * receiver must be in this organisation. The route's `repair:assign` permission
 * covers the first of those and cannot express the second.
 */
export async function assignItemToTechnician(itemId: string, orgId: string, userId: string, dto: AssignRepairItem) {
  const technicianId = dto.technicianId ?? null

  const assigner = await canAssignTriage(userId, orgId)
  if (!assigner.ok) {
    throw new ForbiddenError(assigner.reason === 'not_a_member'
      ? 'Only an administrator of this organisation can assign a triage'
      : 'Only a system administrator or the platform administrator can assign a triage')
  }

  if (technicianId) {
    const assignee = await canReceiveTriage(technicianId, orgId)
    if (!assignee.ok) {
      throw new ForbiddenError(assignee.reason === 'not_a_member'
        ? 'That person is not an active member of this organisation'
        : 'A triage can only be given to a technician')
    }
  }

  const result = await repo.assignItem(itemId, orgId, userId, {
    technicianId,
    ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
  })
  if (!result.item) return result

  const assignmentEmail = technicianId
    ? await notifyRepairAssignment({
      itemId,
      orgId,
      assignedById: userId,
      assignedToId: technicianId,
      reason: dto.reason ?? 'Assigned',
    })
    : { sent: false as const, reason: 'unassigned' as const }

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
 *
 * ## A sign-off is a claim about work somebody did
 *
 * "I went, and this is what I found", recorded under a name, on a trail people
 * order spare parts from. So it is the assignee's to make — see
 * canSignOffTriage for who else, and why each of them is not a matter of
 * seniority. The route's `repair:resolve` is held by every technician in the
 * organisation, which is right and which says nothing about WHICH job; this is
 * the part that does.
 *
 * Checked BEFORE the write, not after: repo.resolveItem is the only path to
 * the 'fixed' stage, and a refusal that arrives after the row has moved is not
 * a refusal.
 */
export async function closeItem(itemId: string, orgId: string, userId: string, dto: ResolveItem) {
  const owner = await repo.findItemOwnership(itemId, orgId)
  if (owner && !owner.resolved) {
    const allowed = await canSignOffTriage(userId, orgId, owner)
    if (!allowed.ok) {
      throw new ForbiddenError(
        'Only the person this job is assigned to, whoever filed it, or an administrator of this organisation can sign it off',
      )
    }
  }

  // A fixed probe has its spares fitted; a failed sign-off never waits on them.
  if (dto.verdict === 'fixed') await assertNoOutstandingParts(itemId, orgId)

  const item = await repo.resolveItem(itemId, orgId, userId, dto)
  if (!item) return null

  // Fuel Audit: a fixed probe closes the fuel cases that found it faulty; a
  // failed sign-off is logged on them. Best-effort, see repairSignedOff.
  await repairSignedOff(orgId, itemId)

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
