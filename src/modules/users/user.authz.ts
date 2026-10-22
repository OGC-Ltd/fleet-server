/**
 * Who may delete whom.
 *
 * ## The rule, as the operator stated it
 *
 *   · The platform administrator, an organisation's system administrator and
 *     its admin may delete accounts.
 *   · Only accounts in the same organisation.
 *   · Only accounts in the same GROUP — see user-group.scope. Gated on
 *     USER_GROUP_ENFORCE, and inert until it is on.
 *   · An admin may NOT delete a system administrator, the platform
 *     administrator, a director or a manager.
 *
 * The last line is the only one that is not already implied by `user:delete`,
 * and it is the reason this file exists: a permission is a fact about the
 * person clicking, and no permission can express "except against these
 * people". `user:delete` is held by `admin` and, through the wildcard, by
 * `super_admin` — and by `hr`, which is a separate question flagged where the
 * matrix is pinned.
 *
 * ## Seniority is the wrong word for it
 *
 * This is not a ladder of rank. It is a rule against an organisation's
 * administrator being able to remove the people who oversee them — the
 * platform administrator above them, a peer administrator beside them, and the
 * director and manager whose accounts exist to hold them to account. An
 * administrator who can delete their own auditors is an administrator with no
 * auditors.
 */

import { prisma } from '../../lib/prisma.js'
import { groupScopeFor } from './user-group.scope.js'

/** Roles whose holders may delete an account at all. */
export const DELETER_ROLE_SLUGS = ['admin', 'super_admin'] as const

/** Platform roles reach every tenant without a membership. */
const PLATFORM_ROLE_SLUGS = new Set<string>(['super_admin'])

/**
 * Roles an ORG administrator may not delete.
 *
 * `system_admin` is in here as well as `admin`. The live database carries both
 * slugs and both display as "System Administrator", which is a trap of its
 * own — but for this rule the answer is the same either way, so the ambiguity
 * costs nothing: neither is deletable by an admin.
 */
const PROTECTED_FROM_ADMIN = new Set<string>([
  'super_admin', 'system_admin', 'admin', 'director', 'manager',
])

export type DeleteCheck =
  | { ok: true }
  | { ok: false; reason: 'wrong_role' | 'not_a_member' | 'protected' | 'other_group'; blockedBy?: string }

/** The live role slugs a person holds in `orgId`, or platform-wide. */
async function roleSlugsFor(userId: string, orgId: string): Promise<Set<string>> {
  const grants = await prisma.userRole.findMany({
    where: {
      userId,
      revokedAt: null,
      role: { OR: [{ organisationId: orgId }, { organisationId: null }] },
    },
    select: { role: { select: { slug: true } } },
  })
  return new Set(grants.map((g) => g.role.slug))
}

/** Home organisation or a live membership — the roster's own rule. */
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
 * May `actorId` delete `targetId` in `orgId`?
 *
 * The platform administrator passes the membership test on the actor side —
 * its remit is every organisation — and is still bound by the target one: a
 * delete is performed upon somebody who belongs somewhere.
 */
export async function canDeleteUser(
  actorId: string,
  targetId: string,
  orgId: string,
): Promise<DeleteCheck> {
  const actorRoles = await roleSlugsFor(actorId, orgId)
  const held = DELETER_ROLE_SLUGS.filter((s) => actorRoles.has(s))
  if (held.length === 0) return { ok: false, reason: 'wrong_role' }

  const isPlatform = held.some((s) => PLATFORM_ROLE_SLUGS.has(s))
  if (!isPlatform && !(await isMemberOf(actorId, orgId))) {
    return { ok: false, reason: 'not_a_member' }
  }

  if (!(await isMemberOf(targetId, orgId))) return { ok: false, reason: 'not_a_member' }

  // The platform administrator is subject to none of the below: there is
  // nobody above them for the rule to protect.
  if (isPlatform) return { ok: true }

  /**
   * Same group, as well as same organisation.
   *
   * Checked here and not only on the roster, because narrowing a LIST while
   * leaving the action open is not a rule — it is a filter, and an id is easy
   * to come by. `groupScopeFor` is unscoped while USER_GROUP_ENFORCE is off,
   * so this is inert until the flag is turned on, and the roster's shadow
   * logging is what reports the effect in the meantime.
   */
  const scope = await groupScopeFor(actorId, orgId)
  if (!scope.unscoped) {
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: {
        groups: {
          where: { group: { organisationId: orgId } },
          select: { groupId: true },
        },
      },
    })
    const sharesGroup = target && (
      scope.groupIds.length === 0
        ? target.groups.length === 0
        : target.groups.some(({ groupId }) => scope.groupIds.includes(groupId))
    )
    if (!sharesGroup) {
      return { ok: false, reason: 'other_group' }
    }
  }

  const targetRoles = await roleSlugsFor(targetId, orgId)
  for (const slug of targetRoles) {
    if (PROTECTED_FROM_ADMIN.has(slug)) return { ok: false, reason: 'protected', blockedBy: slug }
  }
  return { ok: true }
}
