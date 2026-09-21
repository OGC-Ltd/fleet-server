import { enqueueMail, dispatchStatus } from '../../lib/queues/outbound.js'
import { repairAssignmentEmail } from '../../lib/mailer/templates.js'
import { prisma } from '../../lib/prisma.js'

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
  | { sent: false; reason: 'self-assignment' | 'unassigned' | 'no-assignee-email' | 'unconfigured' | 'send-failed' | 'queued'; assigneeName?: string }

export interface NotifyRepairAssignmentInput {
  itemId: string
  orgId: string
  assignedById: string
  assignedToId: string
  reason?: string
}

export async function notifyRepairAssignment(input: NotifyRepairAssignmentInput): Promise<AssignmentEmailResult> {
  if (input.assignedById === input.assignedToId) return { sent: false, reason: 'self-assignment' }

  const [assigner, assignee, item] = await Promise.all([
    prisma.user.findUnique({
      where: { id: input.assignedById },
      select: { fullName: true, email: true },
    }),
    prisma.user.findUnique({
      where: { id: input.assignedToId },
      select: { fullName: true, email: true },
    }),
    prisma.repairReportItem.findUnique({
      where: { id: input.itemId },
      select: {
        vehicle: { select: { registrationPlate: true } },
        faultKind: true,
      },
    }),
  ])

  if (!assignee?.email) return {
    sent: false,
    reason: 'no-assignee-email',
    ...(assignee?.fullName ? { assigneeName: assignee.fullName } : {}),
  }

  const mail = repairAssignmentEmail({
    assigneeName: assignee.fullName ?? 'Technician',
    assignerName: assigner?.fullName ?? 'Operations',
    plate: item?.vehicle?.registrationPlate ?? 'Unknown unit',
    label: item?.faultKind ?? 'Repair task',
    reason: input.reason,
    link: undefined,
  })

  /* Everything above this line stayed synchronous on purpose: the
     self-assignment check, both user lookups and the missing-address case are
     local, fast, and produce the answers a person acts on. Only the SMTP call
     — the one thing that talks to a third party and can take ten seconds —
     moves. So the mail travels to the worker fully rendered and the worker
     opens no database connection of its own. */
  const dispatch = await enqueueMail(assignee.email, assignee.fullName ?? null, mail)
  const assigneeName = assignee.fullName ?? 'Technician'
  const status = dispatchStatus(dispatch)
  return status === 'sent'
    ? { sent: true, assigneeName }
    : { sent: false, reason: status, assigneeName }
}
