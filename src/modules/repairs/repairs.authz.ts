/**
 * Who may hand a triage to whom.
 *
 * SINCE 2026-11-14 BOTH SIDES ARE RIGHTS, set per person in IAM:
 * `repair:assign` to hand one out, `repair:take_jobs` to be handed one. They
 * start on the roles named below. The rest of this note is why the rule
 * exists; read "admin" as "holder of repair:assign" and "technician" as
 * "holder of repair:take_jobs".
 *
 * ## The rule, as the operator stated it
 *
 * A triage under Maintenance is handed out by an ADMINISTRATOR and worked by a
 * TECHNICIAN. Nobody else is in the sentence:
 *
 *   ASSIGNER  the organisation's system administrator (`admin`), who must be a
 *             member of the organisation the job belongs to; or the PLATFORM
 *             administrator (`super_admin`), whose remit is every organisation
 *             by definition and who therefore needs no membership in this one.
 *
 *   ASSIGNEE  a technician, and only a technician — in the SAME ORGANISATION
 *             as the job. The two lists are now disjoint, which is the rule
 *             the operator restated: an administrator hands the work out, a
 *             technician does it, and neither does the other's half.
 *
 * ## The administrator used to be on both sides, and is not any more
 *
 * `admin` and `super_admin` were assignees as well as assigners, so a job
 * could be given to a colleague in the office, or to oneself. That is gone.
 * An administrator who genuinely works jobs holds `technician` as well and is
 * reached by it; an administrator who does not can no longer park a repair
 * under their own name, which is what "only a technician" means when it is
 * enforced rather than merely intended.
 *
 * SIGNING OFF IS UNAFFECTED. `canSignOffTriage` below still lets an
 * administrator close a job — that is how an orphaned job whose technician
 * left is ever closed, and closing is not being assigned.
 *
 * ## Why this is checked here and not left to `repair:assign` alone
 *
 * The route already carries `requirePermissionStrict('repair:assign')`, and the
 * matrix has been narrowed so only the two administrator roles hold it. That
 * gate is necessary and it is not sufficient, for two separate reasons:
 *
 *   1. PERMISSIONS ARE DATA. `ROLE_DEFINITIONS` is what the system SHIPS; the
 *      rows in `permissions` are what it RUNS, and they are editable in the
 *      role editor and only re-seeded deliberately. A narrowing in that file
 *      binds nothing until somebody re-seeds. This check binds today.
 *
 *   2. NO PERMISSION CAN DESCRIBE THE ASSIGNEE. `repair:assign` is a fact
 *      about the person clicking. The rule above is equally a rule about the
 *      person being named, and the server had no opinion on them at all: the
 *      repository asked only `{ id, organisationId }`, so any of the 553 rows
 *      in a tenant — a driver synced from the registry, an operator, a
 *      suspended account — could be made the owner of a repair job and mailed
 *      about it. The dash's picker filtered to the right three roles, which is
 *      a courtesy to whoever uses the dash and no protection whatsoever
 *      against anything else that can reach the endpoint.
 *
 * ## "A member in that organisation"
 *
 * `reachable` below is the same test the user roster runs (see
 * users/user.repository.findAll): HOME ORGANISATION OR A LIVE MEMBERSHIP.
 * `users.organisation_id` records who employs somebody; `org_memberships`
 * records who they may act for, and the two diverge the moment anybody works
 * across sites. Using only the column would refuse a legitimate visiting
 * administrator; using only the membership would refuse the ordinary case of
 * somebody who has never been granted anything beyond their own employer.
 */

import type { RequestHandler } from 'express'
import { prisma } from '../../lib/prisma.js'
import { holdsPermission } from '../../middleware/authorize.js'
import { can, resolveSubject } from '../../lib/authz/subject.js'
import { userHolds } from '../../lib/authz/holders.js'
import { ForbiddenError, NotFoundError } from '../../core/errors/errors.js'

/**
 * The rights that decide a triage (2026-11-14). Until then both sides were role
 * NAMES typed here (admin and super_admin assign, technician is assigned); the
 * user asked for every hidden rule to be a right in IAM. They start where the
 * roles were: `repair:assign` on the admin role (and the System Administrator,
 * through the wildcard), `repair:take_jobs` on the technician role.
 */
export const TRIAGE_ASSIGN_RIGHT = 'repair:assign'
export const TRIAGE_TAKE_RIGHT   = 'repair:take_jobs'

export type TriageRoleCheck =
  | { ok: true }
  | { ok: false; reason: 'not_a_member' | 'wrong_role' }

/**
 * Is this person a member of this organisation, in the roster's sense?
 *
 * Employed by it, or holding a membership in it that has not been revoked.
 * Deleted accounts are nobody.
 */
async function isMemberOf(userId: string, orgId: string): Promise<boolean> {
  const row = await prisma.user.findFirst({
    where: {
      id: userId,
      deletedAt: null,
      OR: [
        { organisationId: orgId },
        { memberships: { some: { organisationId: orgId, revokedAt: null } } },
      ],
    },
    select: { id: true },
  })
  return row !== null
}

/**
 * May `userId` hand out a triage in `orgId`?
 *
 * They must hold `repair:assign` there. A platform role (the System
 * Administrator) reaches every organisation and needs no membership; anybody
 * else must also be a member here.
 */
export async function canAssignTriage(userId: string, orgId: string): Promise<TriageRoleCheck> {
  const subject = await resolveSubject(userId)
  if (!can(subject, orgId, TRIAGE_ASSIGN_RIGHT)) return { ok: false, reason: 'wrong_role' }
  if (subject.isPlatform) return { ok: true }
  return (await isMemberOf(userId, orgId)) ? { ok: true } : { ok: false, reason: 'not_a_member' }
}

/**
 * `canAssignTriage` for many organisations at once: the ones among `orgIds`
 * where this person passes it. For the Alerts page, which lists alerts from
 * every organisation a person holds and draws Escalate / De-escalate only
 * where they may decide.
 */
export async function triageAssignerOrgs(userId: string, orgIds: string[]): Promise<Set<string>> {
  if (orgIds.length === 0) return new Set()
  const subject = await resolveSubject(userId)
  const allowed = orgIds.filter((org) => can(subject, org, TRIAGE_ASSIGN_RIGHT))
  if (subject.isPlatform || allowed.length === 0) return new Set(allowed)
  const me = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      organisationId: true,
      memberships: { where: { organisationId: { in: allowed }, revokedAt: null }, select: { organisationId: true } },
    },
  })
  const member = new Set(me ? [me.organisationId, ...me.memberships.map((m) => m.organisationId)] : [])
  return new Set(allowed.filter((org) => member.has(org)))
}

/**
 * May `userId` be handed one in `orgId`?
 *
 * Only somebody who holds `repair:take_jobs` HERE (the right itself: the
 * System Administrator's wildcard does not put them in the picker), and who is
 * a member here: being assigned is being made responsible for a job inside
 * one organisation (operator: "in the same organization").
 *
 * A suspended or terminated account is refused. The job would be mailed to
 * somebody who cannot sign in to work it, and it would sit open under their
 * name until a human noticed.
 */
export async function canReceiveTriage(userId: string, orgId: string): Promise<TriageRoleCheck> {
  if (!(await userHolds(userId, orgId, TRIAGE_TAKE_RIGHT))) return { ok: false, reason: 'wrong_role' }
  if (!(await isMemberOf(userId, orgId))) return { ok: false, reason: 'not_a_member' }

  const active = await prisma.user.findFirst({
    where: { id: userId, status: { notIn: ['SUSPENDED', 'TERMINATED'] } },
    select: { id: true },
  })
  return active ? { ok: true } : { ok: false, reason: 'not_a_member' }
}

// ---------------------------------------------------------------------------
// Signing a job off
// ---------------------------------------------------------------------------

/**
 * May this person sign off this job?
 *
 * ## The rule
 *
 * A sign-off is a claim about work: "I went, and this is what I found." So the
 * default is that only the person the job was GIVEN to may make it. Three
 * other people may, and each for a reason that is not seniority:
 *
 *   · THE PLATFORM ADMINISTRATOR, whose remit is every organisation.
 *   · AN ADMINISTRATOR OF THIS ORGANISATION, who has to be able to close a job
 *     whose assignee has left, is suspended, or never responded. Without this
 *     a job can be orphaned permanently by one person's absence.
 *   · WHOEVER FILED THE REPORT. They raised the fault; if it turns out to be
 *     nothing, or they fixed it themselves on the spot, they can close their
 *     own ticket without needing somebody to hand it back to them first.
 *
 * ## What this is NOT
 *
 * Not `repair:resolve`. That permission is held by every technician in the
 * organisation, which is correct — a technician must be able to sign off THEIR
 * job — and useless as the whole answer, because it says nothing about WHICH
 * job. The route keeps it as the coarse gate; this decides the rest.
 *
 * ## The unassigned job
 *
 * A job nobody has been given has no assignee to be, so the first two arms and
 * the reporter arm are the whole of it. That is deliberate: an unassigned job
 * closed by a passer-by is a fault nobody was sent to look at, recorded as
 * resolved.
 */
export type SignOffCheck =
  | { ok: true; as: 'assignee' | 'reporter' | 'administrator' }
  | { ok: false; reason: 'not_yours' }

export async function canSignOffTriage(
  userId: string,
  orgId: string,
  item: { assignedToId: string | null; reportedById: string | null },
): Promise<SignOffCheck> {
  if (item.assignedToId && item.assignedToId === userId) return { ok: true, as: 'assignee' }
  if (item.reportedById && item.reportedById === userId) return { ok: true, as: 'reporter' }

  // Same two roles that hand a triage out, and the same scoping: an
  // administrator of THIS organisation, or the platform administrator
  // anywhere. Reusing `canAssignTriage` rather than restating it keeps the two
  // from drifting apart — somebody who may give the work out is exactly
  // somebody who may close it when the person it was given to cannot.
  const admin = await canAssignTriage(userId, orgId)
  return admin.ok ? { ok: true, as: 'administrator' } : { ok: false, reason: 'not_yours' }
}


/**
 * Working a job is the accepted assignee's (operator, 2026-10-01).
 *
 * A technician may move a job's stage, record its inspections, order and
 * collect its parts, and sign it off ONLY when the job is assigned to them
 * and they have accepted it. Every other job they can read, and nothing more.
 *
 * `repair:work_any` lifts the rule: held by every role that could resolve
 * repairs before this rule existed (system administrator, head of section,
 * manager, fleet manager, director), and by the platform administrator
 * through its wildcard. NOT by the technician. Sign-off keeps its own finer
 * rule for those roles (canSignOffTriage).
 *
 * Sits after the route's permission gate, on every route that writes to a job.
 */
export const requireWorkableJob: RequestHandler = async (req, _res, next) => {
  try {
    if (await holdsPermission(req, 'repair:work_any')) return next()
    const orgId = req.params['orgId'] as string
    const itemId = req.params['itemId'] as string
    const job = await prisma.repairReportItem.findFirst({
      where: { id: itemId, organisationId: orgId },
      select: { assignedToId: true, assignmentStatus: true, workshopTechnicianId: true },
    })
    if (!job) throw new NotFoundError('Repair job not found')
    // Repair Workflow: the workshop technician works the job in the workshop
    // as well as the ControlTech technician who triaged it.
    if (job.workshopTechnicianId && job.workshopTechnicianId === req.user?.id) return next()
    if (job.assignedToId !== req.user?.id) {
      throw new ForbiddenError('This job is not assigned to you. You can read it, but only the technician it is assigned to can work it')
    }
    if (job.assignmentStatus !== 'accepted') {
      throw new ForbiddenError('Accept this job before working it')
    }
    next()
  } catch (err) { next(err) }
}
