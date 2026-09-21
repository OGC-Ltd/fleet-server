/**
 * Who may hand a triage to whom.
 *
 * ## The rule, as the operator stated it
 *
 * A triage under Maintenance is handed out by an ADMINISTRATOR and worked by a
 * technician or another administrator. Nobody else is in the sentence:
 *
 *   ASSIGNER  the organisation's system administrator (`admin`), who must be a
 *             member of the organisation the job belongs to; or the PLATFORM
 *             administrator (`super_admin`), whose remit is every organisation
 *             by definition and who therefore needs no membership in this one.
 *
 *   ASSIGNEE  a technician, a system administrator, or the platform
 *             administrator — and in every case somebody IN THAT SAME
 *             ORGANISATION. An administrator may be handed a job by a fellow
 *             administrator; a technician may be handed one by either.
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

import { prisma } from '../../lib/prisma.js'

/** Roles whose holders may hand a triage out. */
export const TRIAGE_ASSIGNER_ROLE_SLUGS = ['admin', 'super_admin'] as const

/** Roles whose holders may be handed one. */
export const TRIAGE_ASSIGNEE_ROLE_SLUGS = ['admin', 'super_admin', 'technician'] as const

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
 * May `userId` be handed one in `orgId`?
 *
 * Membership is required of EVERYBODY here, platform administrator included,
 * and that is not an inconsistency with the rule above. Assigning is an act
 * performed upon an organisation, which a platform remit covers. Being
 * assigned is being made responsible for a job inside one, and the operator
 * bounded it in the same breath every time: "in the same organization".
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
