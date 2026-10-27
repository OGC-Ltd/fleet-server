/**
 * Who hears about each step of the Vehicle Support and Repair Workflow.
 *
 * The channel is in-app notifications plus email (operator, 2026-10-20). Every
 * event writes ONE durable feed item for the organisation (the in-app half,
 * which reaches everyone on the dashboard) and mails the event's audience at
 * their account addresses (the email half). The table is §6 of
 * docs/vehicle-support-repair-workflow-plan.md.
 *
 * Audiences are looked up from live role holders, never from a hand-kept
 * list: the Control Room is `supervisor`, `fleet_analyst` and `operator`; the
 * Head of Security is every holder of `head_of_security` (NOT `hos`, which is
 * Head of Section); ControlTech is the technicians in the `controltech` user
 * group. A vehicle-scoped Control Room holder is mailed only about units in
 * their scope.
 *
 * Like repairs.notify, nothing here throws into the request: a write that
 * succeeded is never undone by a message that did not go.
 */

import type { Prisma } from '../../../generated/prisma/client.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { repairWorkflowEmail } from '../../lib/mailer/templates.js'
import { enqueueMail, enqueueNotification, isAccepted } from '../../lib/queues/outbound.js'
import { pushService } from '../notifications/notifications.service.js'
import { repairRecipients } from './repairs.service.js'

export const CONTROL_ROOM_ROLES = ['supervisor', 'fleet_analyst', 'operator'] as const
export const HEAD_OF_SECURITY_ROLE = 'head_of_security'
/** Who gets a push notification with a repair ticket number once it is
 *  issued — by push, not mail (operator, 2026-10-27). */
export const TICKET_PUSH_ROLES = ['operator', HEAD_OF_SECURITY_ROLE, 'asst_head_of_security'] as const

export type Audience =
  | 'control_room' | 'controltech' | 'assignee' | 'head_of_security' | 'stores' | 'channel'

export interface JobRef {
  itemId:    string
  orgId:     string
  vehicleId: string
  plate:     string
  ticketNo?: string | null
  /** Already humanised: "Brakes", "Fuel probe". */
  label:     string
  stage:     string
  /** Who the job is with: the accepted assignee and the workshop technician. */
  assignedToId?:         string | null
  workshopTechnicianId?: string | null
}

export interface WorkflowEvent {
  /** Deterministic per event, so a retry updates the feed row. */
  key:       string
  severity:  'info' | 'warning' | 'critical'
  headline:  string
  /** One line for the feed. */
  text:      string
  lines?:    { label: string; value: string }[]
  audience:  Audience[]
  at?:       Date
  /** The feed source; 'repair' unless only some viewers may see it
   *  ('repair_flag', 'repair_ticket': see notifications/restricted-sources). */
  source?:   'repair' | 'repair_flag' | 'repair_ticket' | 'repair_verified'
  /** Role slugs whose holders get a Web Push notification of this event. */
  push?:     readonly string[]
  /** People who get a Web Push notification of this event, by user id. */
  pushUsers?: (string | null | undefined)[]
}

const live = {
  deletedAt: null,
  status:    { notIn: ['SUSPENDED', 'TERMINATED'] },
} satisfies Prisma.UserWhereInput

/** Live holders of any of these role slugs in this organisation, with the
 *  vehicle scope applied for scoped memberships. */
export async function roleHolderEmails(orgId: string, slugs: readonly string[], vehicleId?: string): Promise<string[]> {
  return dedupe((await roleHolders(orgId, slugs, vehicleId, true)).map((u) => u.email))
}

/** The same holders as user ids, for push: an account with no email still has
 *  devices. */
export async function roleHolderIds(orgId: string, slugs: readonly string[], vehicleId?: string): Promise<string[]> {
  return [...new Set((await roleHolders(orgId, slugs, vehicleId, false)).map((u) => u.id))]
}

async function roleHolders(orgId: string, slugs: readonly string[], vehicleId: string | undefined, withEmail: boolean) {
  const users = await prisma.user.findMany({
    where: {
      ...live,
      ...(withEmail ? { email: { not: null } } : {}),
      OR: [
        { organisationId: orgId },
        { memberships: { some: { organisationId: orgId, revokedAt: null } } },
      ],
      userRoles: { some: { revokedAt: null, role: { slug: { in: [...slugs] }, organisationId: orgId } } },
    },
    select: {
      id: true,
      email: true,
      memberships: {
        where: { organisationId: orgId, revokedAt: null },
        select: { allVehicles: true, vehicleScopes: { select: { vehicleId: true, vehicleGroupId: true } } },
      },
    },
  })
  let groupId: string | null = null
  if (vehicleId && users.some((u) => u.memberships.some((m) => !m.allVehicles))) {
    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { vehicleGroupId: true } })
    groupId = v?.vehicleGroupId ?? null
  }
  return users.filter((u) => {
    const m = u.memberships[0]
    if (!vehicleId || !m || m.allVehicles) return true
    return m.vehicleScopes.some((s) => s.vehicleId === vehicleId || (groupId && s.vehicleGroupId === groupId))
  })
}

/** Technicians assigned to this organisation. Used to keep them OFF repair
 *  mail: they hear about jobs in the app. */
export async function controltechEmails(orgId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      ...live,
      email: { not: null },
      OR: [
        { organisationId: orgId },
        { memberships: { some: { organisationId: orgId, revokedAt: null } } },
      ],
      userRoles: { some: { revokedAt: null, role: { slug: 'technician', organisationId: orgId } } },
    },
    select: { email: true },
  })
  return dedupe(users.map((u) => u.email))
}

async function userEmails(ids: (string | null | undefined)[]): Promise<string[]> {
  const want = ids.filter((x): x is string => !!x)
  if (want.length === 0) return []
  const users = await prisma.user.findMany({ where: { id: { in: want }, ...live }, select: { email: true } })
  return dedupe(users.map((u) => u.email))
}

function dedupe(list: (string | null | undefined)[]): string[] {
  return [...new Set(list.filter((x): x is string => !!x).map((s) => s.trim().toLowerCase()).filter(Boolean))]
}

function list(raw: string): string[] {
  return dedupe(raw.split(','))
}

/** Every address one event goes to, and whether the Head of Security fallback was used. */
async function resolveAudience(ref: JobRef, audience: Audience[]): Promise<{ to: string[]; securityFallback: boolean }> {
  const out: string[] = []
  let securityFallback = false
  for (const a of audience) {
    try {
      if (a === 'control_room') out.push(...await roleHolderEmails(ref.orgId, CONTROL_ROOM_ROLES, ref.vehicleId))
      // ControlTech is told in the app only: their Live Feed and bell carry
      // the repair notices (operator, 2026-10-27), so they are not mailed.
      if (a === 'assignee') out.push(...await userEmails([ref.assignedToId, ref.workshopTechnicianId]))
      if (a === 'channel') out.push(...repairRecipients())
      // Stores has no role of its own yet (plan Q7b); whoever may issue from
      // stores in this organisation hears about a request.
      if (a === 'stores') out.push(...await roleHolderEmails(ref.orgId, ['admin'], ref.vehicleId))
      if (a === 'head_of_security') {
        const hos = await roleHolderEmails(ref.orgId, [HEAD_OF_SECURITY_ROLE])
        if (hos.length > 0) out.push(...hos)
        else {
          securityFallback = true
          out.push(...list(env.REPAIR_SECURITY_EMAILS))
        }
      }
    } catch (err) {
      logger.error({ err, itemId: ref.itemId, audience: a }, 'repair workflow: could not resolve recipients')
    }
  }
  // No technician is mailed, whichever audience named them (an assignee, a
  // role list): their notices arrive in the app.
  let technicians = new Set<string>()
  try {
    technicians = new Set(await controltechEmails(ref.orgId))
  } catch (err) {
    logger.error({ err, itemId: ref.itemId }, 'repair workflow: could not read the technicians to leave out')
  }
  return { to: dedupe(out).filter((addr) => !technicians.has(addr)), securityFallback }
}

/**
 * Tell the feed and mail the audience. Returns the addresses the mail was
 * accepted for, which the caller may copy onto the trail.
 */
export async function notifyWorkflow(ref: JobRef, ev: WorkflowEvent): Promise<{ to: string[]; accepted: string[] }> {
  const at = ev.at ?? new Date()
  const plateRef = ref.ticketNo ? `${ref.plate} · ${ref.ticketNo}` : ref.plate
  try {
    await enqueueNotification({
      orgId: ref.orgId, id: `repair-wf-${ref.itemId}-${ev.key}`, source: ev.source ?? 'repair', alertType: 'repair_workflow',
      severity: ev.severity, text: `${plateRef} · ${ref.label}: ${ev.text}`, at,
      plate: ref.plate, vehicleId: ref.vehicleId,
    })
  } catch (err) {
    logger.error({ err, itemId: ref.itemId, key: ev.key }, 'repair workflow: could not publish the feed item')
  }

  if (ev.push?.length || ev.pushUsers?.some(Boolean)) {
    try {
      const ids = [...new Set([
        ...(ev.push?.length ? await roleHolderIds(ref.orgId, ev.push, ref.vehicleId) : []),
        ...(ev.pushUsers ?? []).filter((x): x is string => !!x),
      ])]
      await pushService.sendToUsers(ids, {
        title: ev.headline,
        body:  `${plateRef} · ${ref.label}: ${ev.text}`,
        tag:   `repair-${ev.key}-${ref.itemId}`,
        icon:  '/logo-icon.png',
        data:  { url: '/', orgId: ref.orgId, itemId: ref.itemId },
      })
    } catch (err) {
      logger.error({ err, itemId: ref.itemId, key: ev.key }, 'repair workflow: could not send the push notification')
    }
  }

  const { to, securityFallback } = await resolveAudience(ref, ev.audience)
  if (securityFallback) {
    try {
      await enqueueNotification({
        orgId: ref.orgId, id: `repair-wf-nohos-${ref.orgId}-${at.toISOString().slice(0, 10)}`,
        source: 'repair', alertType: 'repair_workflow', severity: 'warning',
        text: 'No Head of Security in this organisation: suspected malicious damage could not be sent to one. Grant the role in the role editor.',
        at,
      })
    } catch { /* the warning is a courtesy; the notice itself went to the feed */ }
  }
  if (to.length === 0) return { to, accepted: [] }

  let orgName = 'Fleet'
  try {
    orgName = (await prisma.organisation.findUnique({ where: { id: ref.orgId }, select: { name: true } }))?.name ?? orgName
  } catch { /* the name is decoration */ }

  const mail = repairWorkflowEmail({
    orgName,
    headline: ev.headline,
    plate:    ref.plate,
    ticketNo: ref.ticketNo ?? null,
    stage:    ref.stage,
    lines:    [{ label: 'Fault', value: ref.label }, ...(ev.lines ?? [])],
    critical: ev.severity === 'critical',
    ...(env.APP_BASE_URL ? { link: env.APP_BASE_URL } : {}),
  })
  try {
    const results = await Promise.all(to.map((addr) => enqueueMail(addr, null, mail)))
    return { to, accepted: to.filter((_, i) => isAccepted(results[i]!)) }
  } catch (err) {
    logger.error({ err, itemId: ref.itemId, key: ev.key }, 'repair workflow: could not send mail')
    return { to, accepted: [] }
  }
}
