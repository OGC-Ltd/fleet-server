import { sendMail } from '../../lib/mailer/mailer.js'
import { repairAssignmentEmail } from '../../lib/mailer/templates.js'
import { prisma } from '../../lib/prisma.js'

export type AssignmentEmailResult =
  | { sent: true; assigneeName: string }
  | { sent: false; reason: 'self-assignment' | 'no-assignee-email' | 'unconfigured' | 'send-failed'; assigneeName?: string }

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

  const result = await sendMail(assignee.email, assignee.fullName ?? null, mail)
  return result.sent
    ? { sent: true, assigneeName: assignee.fullName ?? 'Technician' }
    : { sent: false, reason: result.reason, assigneeName: assignee.fullName ?? 'Technician' }
}
