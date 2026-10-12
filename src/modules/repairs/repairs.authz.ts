/**
 * Who may hand a triage to whom.
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
import { ForbiddenError, NotFoundError } from '../../core/errors/errors.js'

/** Roles whose holders may hand a triage out. */
export const TRIAGE_ASSIGNER_ROLE_SLUGS = ['admin', 'super_admin'] as const

/** Roles whose holders may be handed one. Deliberately disjoint from the
 *  assigner list above: only a technician works a triage. */
export const TRIAGE_ASSIGNEE_ROLE_SLUGS = ['technician'] as const

/**
 * Platform roles reach every tenant without a membership — that is what makes
 * them platform roles, and the operator said so explicitly of this one: the
 * platform administrator may assign a triage in any organisation. Held apart
 * from the org-scoped slugs because the membership test below must not run
 * against it.
 */
const PLATFORM_ROLE_SLUGS = new Set<string>(['super_admin'])

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

/** The live role slugs this person holds, either in `orgId` or platform-wide. */
async function roleSlugsFor(userId: string, orgId: string): Promise<Set<string>> {
  const grants = await prisma.userRole.findMany({
    where: {
      userId,
      revokedAt: null,
      // A platform role (organisation_id IS NULL) applies everywhere; an
      // org-scoped one only where it was granted. A role named `admin` in
      // ANOTHER tenant must not answer for this one, which is the whole
      // reason this is not a bare slug lookup.
      role: { OR: [{ organisationId: orgId }, { organisationId: null }] },
    },
    select: { role: { select: { slug: true } } },
  })
  return new Set(grants.map((g) => g.role.slug))
}

/**
 * May `userId` hand out a triage in `orgId`?
 *
 * The platform administrator passes on the role alone. Everybody else must
 * also be a member here — an `admin` of Menengai is not an administrator of
 * Kabras, and the role row being org-scoped already says so, but the
 * membership test is what makes that legible in the refusal.
 */
export async function canAssignTriage(userId: string, orgId: string): Promise<TriageRoleCheck> {
  const slugs = await roleSlugsFor(userId, orgId)
  const held = TRIAGE_ASSIGNER_ROLE_SLUGS.filter((s) => slugs.has(s))
  if (held.length === 0) return { ok: false, reason: 'wrong_role' }
  if (held.some((s) => PLATFORM_ROLE_SLUGS.has(s))) return { ok: true }
  return (await isMemberOf(userId, orgId)) ? { ok: true } : { ok: false, reason: 'not_a_member' }
}

/**
 * `canAssignTriage` for many organisations at once: the ones among `orgIds`
 * where this person passes it. For the Alerts page, which lists alerts from
 * every organisation a person holds and draws Escalate / De-escalate only
 * where they may decide; two queries however many organisations there are.
 */
export async function triageAssignerOrgs(userId: string, orgIds: string[]): Promise<Set<string>> {
  if (orgIds.length === 0) return new Set()
  const [grants, me] = await Promise.all([
    prisma.userRole.findMany({
      where: {
        userId,
        revokedAt: null,
        role: {
          slug: { in: [...TRIAGE_ASSIGNER_ROLE_SLUGS] },
          OR: [{ organisationId: { in: orgIds } }, { organisationId: null }],
        },
      },
      select: { role: { select: { slug: true, organisationId: true } } },
    }),
    prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        organisationId: true,
        memberships: { where: { organisationId: { in: orgIds }, revokedAt: null }, select: { organisationId: true } },
      },
    }),
  ])
  // The same two arms as canAssignTriage: a platform slug passes on the role
  // alone; any other needs a membership in the organisation. A role row with
  // no organisation applies in every one of them.
  const member = new Set(me ? [me.organisationId, ...me.memberships.map((m) => m.organisationId)] : [])
  const out = new Set<string>()
  for (const g of grants) {
    const where = g.role.organisationId === null ? orgIds : [g.role.organisationId]
    for (const org of where) {
      if (PLATFORM_ROLE_SLUGS.has(g.role.slug) || member.has(org)) out.add(org)
    }
  }
  return out
}

/**
 * May `userId` be handed one in `orgId`?
 *
 * Only a technician, and only one who is a member HERE. Membership is required
 * of everybody, and that is not an inconsistency with the rule above: assigning
 * is an act performed upon an organisation, which a platform remit covers.
 * Being assigned is being made responsible for a job inside one, and the
 * operator bounded it in the same breath every time: "in the same
 * organization". (A platform administrator now fails the role test first, so
 * the membership arm is reached only by a technician from another tenant.)
 *
 * A suspended or terminated account is refused. The job would be mailed to
 * somebody who cannot sign in to work it, and it would sit open under their
 * name until a human noticed.
 */
export async function canReceiveTriage(userId: string, orgId: string): Promise<TriageRoleCheck> {
  const slugs = await roleSlugsFor(userId, orgId)
  if (!TRIAGE_ASSIGNEE_ROLE_SLUGS.some((s) => slugs.has(s))) return { ok: false, reason: 'wrong_role' }
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
      select: { assignedToId: true, assignmentStatus: true },
    })
    if (!job) throw new NotFoundError('Repair job not found')
    if (job.assignedToId !== req.user?.id) {
      throw new ForbiddenError('This job is not assigned to you. You can read it, but only the technician it is assigned to can work it')
    }
    if (job.assignmentStatus !== 'accepted') {
      throw new ForbiddenError('Accept this job before working it')
    }
    next()
  } catch (err) { next(err) }
}
