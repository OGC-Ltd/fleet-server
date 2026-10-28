import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { pushService } from '../notifications/notifications.service.js'

/**
 * `queued` sits with the NOT-SENT reasons, and that placement is the point.
 *
 * Every other reason here is terminal: nothing further will happen and the
 * screen should say so. `queued` is the opposite — it WILL be attempted, up
 * to three times — but it has not been yet, and the dashboard prints this
 * verbatim. A queued mail shown as sent is the exact lie lib/mailer's docblock
 * forbids: the assigner walks away believing the technician has been told.
 */
export type AssignmentEmailResult =
  | { sent: true; assigneeName: string }
  | { sent: false; reason: 'self-assignment' | 'in-app' | 'unassigned' | 'no-assignee-email' | 'unconfigured' | 'send-failed' | 'queued'; assigneeName?: string }

export interface NotifyRepairAssignmentInput {
  itemId: string
  orgId: string
  assignedById: string
  assignedToId: string
  reason?: string
}

export async function notifyRepairAssignment(input: NotifyRepairAssignmentInput): Promise<AssignmentEmailResult> {
  if (input.assignedById === input.assignedToId) return { sent: false, reason: 'self-assignment' }

  // Technicians are not mailed: the assignment reaches them in the app's Live
  // Feed and bell (operator, 2026-10-27).
  const technician = await prisma.userRole.findFirst({
    where:  { userId: input.assignedToId, revokedAt: null, role: { slug: 'technician', organisationId: input.orgId } },
    select: { id: true, user: { select: { fullName: true } } },
  })
  if (technician) {
    return { sent: false, reason: 'in-app', ...(technician.user.fullName ? { assigneeName: technician.user.fullName } : {}) }
  }

  const [assigner, assignee, item] = await Promise.all([
    prisma.user.findUnique({
      where: { id: input.assignedById },
      select: { fullName: true },
    }),
    prisma.user.findUnique({
      where: { id: input.assignedToId },
      select: { fullName: true },
    }),
    prisma.repairReportItem.findUnique({
      where: { id: input.itemId },
      select: {
        vehicle: { select: { registrationPlate: true } },
        faultKind: true,
      },
    }),
  ])

  // By Web Push, not mail (operator, 2026-10-28): every device the assignee
  // turned notifications on from. The assignment is also on their feed, so
  // the answer is the same `in-app` a technician gets.
  const assigneeName = assignee?.fullName ?? 'Technician'
  const plate = item?.vehicle?.registrationPlate ?? 'Unknown unit'
  try {
    await pushService.sendToUsers([input.assignedToId], {
      title: 'Repair triage assigned to you',
      body:  `${plate} · ${item?.faultKind ?? 'Repair task'} — from ${assigner?.fullName ?? 'Operations'}${input.reason ? `: ${input.reason}` : ''}`,
      tag:   `repair-assign-${input.itemId}`,
      icon:  '/logo-icon.png',
      data:  { url: '/', orgId: input.orgId, itemId: input.itemId },
    })
  } catch (err) {
    logger.error({ err, itemId: input.itemId }, 'repair assignment: could not send the push notification')
    return { sent: false, reason: 'send-failed', assigneeName }
  }
  return { sent: false, reason: 'in-app', assigneeName }
}
