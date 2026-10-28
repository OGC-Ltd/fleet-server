/**
 * The Fuel Audit report, sent when an audit is done (operator, 2026-10-01) —
 * by Web Push since 2026-10-28, when mail was kept for account access and
 * escalations only. The push is the summary; the full report (the trail,
 * inspections, parts) is on the Audit page it opens.
 *
 * An audit is done when the probe repair its cases wait on is signed off:
 * fixed (the cases close, PROBE_FIXED) or unsuccessful (logged on them,
 * REPAIR_FAILED). repairSignedOff calls this once per sign-off that changed
 * a case, from the sign-off hook or the Audit page's catch-up, never both.
 *
 * The report carries everything on the audit: the unit, each fuel alert that
 * was found to be a faulty probe and who decided so, the repair job and its
 * progress, the probe inspection checklist, the spare parts with their cost,
 * and how it was signed off.
 *
 * Recipients are the people the operator named, by ROLE, in this organisation:
 * head of security, assistant head of security, fleet manager, dispatch
 * manager, fleet analyst, manager, system administrator; and the platform
 * roles, director and platform administrator. Only live grants on active,
 * undeleted accounts with an address.
 */

import { prisma } from '../../lib/prisma.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { type FuelAuditReport } from '../../lib/mailer/templates.js'
import { pushService } from '../notifications/notifications.service.js'

export const AUDIT_REPORT_ROLE_SLUGS = [
  'head_of_security', 'asst_head_of_security', 'fleet_manager', 'dispatcher',
  'fleet_analyst', 'manager', 'admin', 'director', 'super_admin',
] as const

/** Everybody the report goes to in `orgId`, one entry per address. */
export async function auditReportRecipients(orgId: string): Promise<Array<{ id: string; email: string; name: string | null }>> {
  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      email: { not: null },
      userRoles: {
        some: {
          revokedAt: null,
          role: {
            slug: { in: [...AUDIT_REPORT_ROLE_SLUGS] },
            // A role granted here, or a platform role (it reaches every org).
            OR: [{ organisationId: orgId }, { organisationId: null }],
          },
        },
      },
    },
    select: { id: true, email: true, fullName: true },
  })
  const seen = new Map<string, { id: string; email: string; name: string | null }>()
  for (const u of users) {
    const email = u.email?.trim().toLowerCase()
    if (email && !seen.has(email)) seen.set(email, { id: u.id, email, name: u.fullName ?? null })
  }
  return [...seen.values()]
}

const PERSON = { select: { fullName: true } } as const

/** Everything the report says, read fresh after the sign-off. */
async function gather(orgId: string, repairItemId: string, caseIds: string[]): Promise<FuelAuditReport | null> {
  const [org, job, cases, parts, inspections] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true } }),
    prisma.repairReportItem.findFirst({
      where: { id: repairItemId, organisationId: orgId },
      select: {
        stage: true, outcome: true, faultKind: true, problemNote: true, fixNote: true, recommendation: true,
        createdAt: true, resolvedAt: true, stageHistory: true, expectedResolutionAt: true,
        vehicle: { select: { registrationPlate: true } },
        assignedTo: PERSON, resolvedBy: PERSON,
        report: { select: { reportedBy: PERSON } },
      },
    }),
    prisma.fuelTheftFollowUp.findMany({
      where: { id: { in: caseIds } },
      orderBy: { openedAt: 'asc' },
      select: {
        status: true,
        theft: { select: { stolenMl: true, beganAt: true, drainCause: true } },
        actions: { orderBy: { at: 'asc' }, select: { kind: true, note: true, at: true, actor: PERSON } },
      },
    }),
    prisma.repairSparePart.findMany({ where: { repairItemId }, orderBy: { orderedAt: 'asc' } }),
    prisma.repairInspection.findMany({ where: { repairItemId }, orderBy: { inspectedAt: 'asc' } }),
  ])
  if (!job || !job.resolvedAt) return null

  const history = Array.isArray(job.stageHistory) ? job.stageHistory as Array<Record<string, unknown>> : []
  return {
    orgName: org?.name ?? 'Fleet',
    plate: job.vehicle.registrationPlate,
    verdict: job.stage === 'fixed' ? 'fixed' : 'unsuccessful',
    signedOffBy: job.resolvedBy?.fullName ?? null,
    signedOffAt: job.resolvedAt,
    fixNote: job.fixNote,
    recommendation: job.recommendation,
    job: {
      raisedAt: job.createdAt,
      raisedBy: job.report?.reportedBy?.fullName ?? null,
      technician: job.assignedTo?.fullName ?? null,
      problemNote: job.problemNote,
      fixDate: job.expectedResolutionAt,
      stages: history.map((h) => ({
        stage: String(h['stage'] ?? ''),
        at: new Date(String(h['at'] ?? '')),
        by: (h['byName'] as string | undefined) ?? null,
        note: (h['note'] as string | undefined) ?? null,
      })).filter((s) => !Number.isNaN(s.at.getTime())),
    },
    alerts: cases.map((c) => ({
      beganAt: c.theft.beganAt,
      litres: Math.round(c.theft.stolenMl / 100) / 10,
      cause: c.theft.drainCause ?? null,
      trail: c.actions.map((a) => ({ kind: a.kind, at: a.at, by: a.actor?.fullName ?? null, note: a.note })),
    })),
    inspections: inspections.map((i) => ({ component: i.component, verdict: i.verdict, note: i.note, by: i.inspectedBy, at: i.inspectedAt })),
    parts: parts.map((p) => ({
      name: p.name, quantity: p.quantity, supplier: p.supplier, costKes: p.costKes, status: p.status,
      orderedAt: p.orderedAt, receivedAt: p.receivedAt, fittedAt: p.fittedAt, fixPlannedAt: p.fixPlannedAt,
    })),
    ...(env.APP_BASE_URL ? { link: env.APP_BASE_URL } : {}),
  }
}

/** The push for one report: what was decided, on which unit, in one line. */
export function fuelAuditPush(r: FuelAuditReport): { title: string; body: string } {
  const n = r.alerts.length
  const verdict = r.verdict === 'fixed' ? 'probe fixed' : 'probe repair unsuccessful'
  const by = r.signedOffBy ? ` by ${r.signedOffBy}` : ''
  const cost = r.parts.filter((p) => p.status !== 'cancelled').reduce((t, p) => t + (p.costKes ?? 0), 0)
  return {
    title: `Fuel audit done: ${r.plate}`,
    body: `${verdict}${by} · ${n} fuel alert${n === 1 ? '' : 's'} found to be a faulty probe`
      + (cost > 0 ? ` · parts KES ${cost.toLocaleString('en-KE')}` : '')
      + (r.fixNote ? ` — ${r.fixNote}` : ''),
  }
}

/**
 * Push the report for one signed-off audit. Best-effort: a notice that cannot
 * go never undoes the sign-off, and every outcome is logged.
 */
export async function sendFuelAuditReport(orgId: string, repairItemId: string, caseIds: string[]): Promise<void> {
  if (caseIds.length === 0) return
  try {
    const [report, recipients] = await Promise.all([
      gather(orgId, repairItemId, caseIds),
      auditReportRecipients(orgId),
    ])
    if (!report) return
    if (recipients.length === 0) {
      logger.warn({ orgId, repairItemId }, 'fuel audit report: nobody holds a recipient role — nothing sent')
      return
    }
    await pushService.sendToUsers(recipients.map((r) => r.id), {
      ...fuelAuditPush(report),
      tag:  `fuel-audit-${repairItemId}`,
      icon: '/logo-icon.png',
      data: { url: '/', orgId, repairItemId },
    })
    logger.info({ orgId, repairItemId, recipients: recipients.length }, 'fuel audit report: pushed')
  } catch (err) {
    logger.error({ err, orgId, repairItemId }, 'fuel audit report: could not be sent')
  }
}
