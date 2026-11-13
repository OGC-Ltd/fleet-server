/**
 * Who hears about each step of the Vehicle Support and Repair Workflow.
 *
 * The channel is in-app notifications plus Web Push (operator, 2026-10-28;
 * it was email from 2026-10-20). Every event writes ONE durable feed item for
 * the organisation (the in-app half, which reaches everyone on the dashboard)
 * and pushes to the event's audience on every device they turned
 * notifications on from. The table is §6 of
 * docs/vehicle-support-repair-workflow-plan.md.
 *
 * Audiences are the live holders of a RIGHT (lib/authz/holders), set per
 * person in IAM since 2026-11-14; until then they were role names here. The
 * Control Room is `notification:push_control_room` (supervisor, fleet
 * analyst, operator to start with); the Head of Security is
 * `security_case:hold`; stores is `notification:push_stores` (admin);
 * ControlTech is `repair:take_jobs` (technicians), told in the app and never
 * pushed. A holder with a fleet limit is told only about units in it.
 *
 * Like repairs.notify, nothing here throws into the request: a write that
 * succeeded is never undone by a message that did not go.
 */

import type { Prisma } from '../../../generated/prisma/client.js'
import { env } from '../../config/env.js'
import { holdersOf } from '../../lib/authz/holders.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { enqueueNotification } from '../../lib/queues/outbound.js'
import { pushService } from '../notifications/notifications.service.js'
import { repairRecipients } from './repairs.service.js'

/** The rights whose holders make up each audience (see the header). */
export const CONTROL_ROOM_RIGHT = 'notification:push_control_room'
export const SECURITY_RIGHT     = 'security_case:hold'
export const STORES_RIGHT       = 'notification:push_stores'
export const TAKES_JOBS_RIGHT   = 'repair:take_jobs'
/** Who gets a push notification with a repair ticket number once it is
 *  issued — by push, not mail (operator, 2026-10-27). */
export const TICKET_PUSH = ['notification:push_tickets'] as const
/** Who gets a push when a repair is completed and tested, to verify it. */
export const COMPLETED_PUSH = ['notification:push_completed'] as const

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
  /** Rights (permission slugs) whose holders get a Web Push of this event. */
  push?:     readonly string[]
  /** People who get a Web Push notification of this event, by user id. */
  pushUsers?: (string | null | undefined)[]
  /** Whoever took the action. They are left out of the push and the mail,
   *  and their feed shows the line as read: the notice is for everyone else
   *  (operator, 2026-10-27). */
  actorId?:  string | null
}

const live = {
  deletedAt: null,
  status:    { notIn: ['SUSPENDED', 'TERMINATED'] },
} satisfies Prisma.UserWhereInput

/** Live holders of any of these rights in this organisation, with their
 *  fleet limit applied when the notice is about one unit. */
export async function rightHolderEmails(orgId: string, rights: readonly string[], vehicleId?: string): Promise<string[]> {
  return dedupe((await holdersOf(orgId, rights, { vehicleId, withEmail: true })).map((u) => u.email))
}

/** The same holders as user ids, for push: an account with no email still has
 *  devices. */
export async function rightHolderIds(orgId: string, rights: readonly string[], vehicleId?: string): Promise<string[]> {
  return [...new Set((await holdersOf(orgId, rights, { vehicleId })).map((u) => u.id))]
}

/** Whoever may be handed jobs here (`repair:take_jobs`, technicians to start
 *  with). Used to keep them OFF repair mail: they hear about jobs in the app. */
export async function controltechEmails(orgId: string): Promise<string[]> {
  return rightHolderEmails(orgId, [TAKES_JOBS_RIGHT])
}

/** The actor's own address, to leave off the mail. */
async function actorEmail(id: string | null | undefined): Promise<string | null> {
  if (!id) return null
  const u = await prisma.user.findUnique({ where: { id }, select: { email: true } })
  return u?.email?.trim().toLowerCase() || null
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
      if (a === 'control_room') out.push(...await rightHolderEmails(ref.orgId, [CONTROL_ROOM_RIGHT], ref.vehicleId))
      // ControlTech is told in the app only: their Live Feed and bell carry
      // the repair notices (operator, 2026-10-27), so they are not mailed.
      if (a === 'assignee') out.push(...await userEmails([ref.assignedToId, ref.workshopTechnicianId]))
      if (a === 'channel') out.push(...repairRecipients())
      // Stores has no role of its own yet (plan Q7b); the holders of
      // notification:push_stores (admins to start with) hear about a request.
      if (a === 'stores') out.push(...await rightHolderEmails(ref.orgId, [STORES_RIGHT], ref.vehicleId))
      if (a === 'head_of_security') {
        const hos = await rightHolderEmails(ref.orgId, [SECURITY_RIGHT])
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
 * Tell the feed and push to the audience. Returns the audience's addresses
 * and those that had an account to push to.
 *
 * The audience was mailed until 2026-10-28; it is now pushed to instead, the
 * same people (live right holders, scoped, technicians and the actor left
 * out), together with the event's own `push` roles and `pushUsers`, in one
 * send so nobody gets the same notice twice.
 */
export async function notifyWorkflow(ref: JobRef, ev: WorkflowEvent): Promise<{ to: string[]; accepted: string[] }> {
  const at = ev.at ?? new Date()
  const plateRef = ref.ticketNo ? `${ref.plate} · ${ref.ticketNo}` : ref.plate
  try {
    await enqueueNotification({
      orgId: ref.orgId, id: `repair-wf-${ref.itemId}-${ev.key}`, source: ev.source ?? 'repair', alertType: 'repair_workflow',
      severity: ev.severity, text: `${plateRef} · ${ref.label}: ${ev.text}`, at,
      plate: ref.plate, vehicleId: ref.vehicleId, actorId: ev.actorId ?? null,
    })
  } catch (err) {
    logger.error({ err, itemId: ref.itemId, key: ev.key }, 'repair workflow: could not publish the feed item')
  }

  const resolved = await resolveAudience(ref, ev.audience)
  const { securityFallback } = resolved
  let to = resolved.to
  try {
    const own = await actorEmail(ev.actorId)
    if (own) to = to.filter((addr) => addr !== own)
  } catch (err) {
    logger.error({ err, itemId: ref.itemId }, 'repair workflow: could not read the actor to leave out')
  }
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

  let accepted: string[] = []
  try {
    const audience = await pushService.usersForEmails(to)
    accepted = to.filter((addr) => !audience.unmatched.includes(addr))
    const ids = [...new Set([
      ...audience.ids,
      ...(ev.push?.length ? await rightHolderIds(ref.orgId, ev.push, ref.vehicleId) : []),
      ...(ev.pushUsers ?? []).filter((x): x is string => !!x),
    ])].filter((id) => id !== ev.actorId)
    await pushService.sendToUsers(ids, {
      title: ev.headline,
      body:  `${plateRef} · ${ref.label}: ${ev.text}`,
      tag:   `repair-${ev.key}-${ref.itemId}`,
      icon:  '/logo-icon.png',
      data:  { url: '/', orgId: ref.orgId, itemId: ref.itemId, critical: ev.severity === 'critical' },
    })
  } catch (err) {
    logger.error({ err, itemId: ref.itemId, key: ev.key }, 'repair workflow: could not send the push notification')
  }
  return { to, accepted }
}
