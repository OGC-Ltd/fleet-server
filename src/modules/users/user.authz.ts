/**
 * Who may see, change and delete whom.
 *
 * ## Rights, not role names (2026-11-14)
 *
 * Until 2026-11-14 these rules were role NAMES typed here: only `admin` and
 * `super_admin` could manage accounts at all; a supervisor saw operator
 * accounts only; an operator was kept out of the directory; an admin could
 * grant only the roles below admin, and could not edit or delete an Admin, a
 * Director or a System Administrator. The user asked for every such hidden
 * rule to be a right in IAM. Each is now decided by a permission, set per
 * person:
 *
 *   user:read / user:create / user:update / user:delete / user:assign_role
 *       the route's own check, and nothing on top of it any more;
 *   user:read_all          see every account, not only operators (every role
 *                          holds it to start with);
 *   user:manage_protected  edit or remove Admins, Directors and System
 *                          Administrators (the System Administrator alone, by
 *                          the wildcard, to start with);
 *   role:assign_senior     grant the Admin and Head of Section roles (nobody
 *                          but the System Administrator to start with).
 *
 * Two rules are not rights and stay: an account is acted on only inside an
 * organisation it belongs to, and inside a GROUP the actor shares
 * (user-group.scope); and the platform roles (System Administrator,
 * Director), which reach every organisation, are granted only by the System
 * Administrator, like the wildcard itself.
 */

import { prisma } from '../../lib/prisma.js'
import { can, resolveSubject } from '../../lib/authz/subject.js'
import { groupScopeFor } from './user-group.scope.js'
import { ASSIGNABLE_ROLE_SLUGS, PLATFORM_ROLE_SLUGS, WILDCARD } from '../../lib/permissions.js'

/** See every account in the directory, not only operator accounts. */
export const READ_ALL_RIGHT = 'user:read_all'
/** Edit or remove the accounts in PROTECTED_ROLE_SLUGS. */
export const MANAGE_PROTECTED_RIGHT = 'user:manage_protected'
/** Grant the organisation roles above ASSIGNABLE_ROLE_SLUGS (Admin, Head of Section). */
export const ASSIGN_SENIOR_RIGHT = 'role:assign_senior'

/**
 * Accounts that only a holder of `user:manage_protected` may edit or delete.
 *
 * `system_admin` is in here as well as `admin`. The live database carries both
 * slugs and both display as "System Administrator", which is a trap of its
 * own — but for this rule the answer is the same either way.
 */
export const PROTECTED_ROLE_SLUGS: ReadonlySet<string> = new Set([
  'super_admin', 'system_admin', 'admin', 'director',
])

/** The accounts somebody without `user:read_all` sees: operators. */
export const READ_LIMITED_TO = 'operator'

export type DeleteCheck =
  | { ok: true; platformAdmin: boolean }
  | { ok: false; reason: 'wrong_role' | 'not_a_member' | 'protected' | 'other_group'; blockedBy?: string }

export type EditCheck = { ok: true } | { ok: false; blockedBy: string }

/** The live role slugs a person holds in `orgId`, or platform-wide. */
export async function roleSlugsFor(userId: string, orgId: string | null): Promise<Set<string>> {
  const grants = await prisma.userRole.findMany({
    where: {
      userId,
      revokedAt: null,
      role: orgId === null
        ? { organisationId: null }
        : { OR: [{ organisationId: orgId }, { organisationId: null }] },
    },
    select: { role: { select: { slug: true } } },
  })
  return new Set(grants.map((g) => g.role.slug))
}

/** The role filter on this person's user roster: null for every account. */
export async function visibleRoleSlugFor(userId: string, orgId: string): Promise<string | null> {
  return can(await resolveSubject(userId), orgId, READ_ALL_RIGHT) ? null : READ_LIMITED_TO
}

/** May `actorId` open `targetId`'s account? (The route already checked user:read.) */
export async function canViewUser(actorId: string, targetId: string, orgId: string): Promise<boolean> {
  if (can(await resolveSubject(actorId), orgId, READ_ALL_RIGHT)) return true
  return (await roleSlugsFor(targetId, orgId)).has(READ_LIMITED_TO)
}

/**
 * May `actorId` grant these roles in `orgId`? They must hold
 * `user:assign_role`. The roles below admin are open to them; Admin and Head
 * of Section need `role:assign_senior`; a platform role needs the wildcard.
 */
export async function canManageRoleSlugs(
  actorId: string,
  orgId: string,
  roleSlugs: string[],
): Promise<boolean> {
  const subject = await resolveSubject(actorId)
  if (can(subject, orgId, WILDCARD)) return true
  if (!can(subject, orgId, 'user:assign_role')) return false
  const senior = can(subject, orgId, ASSIGN_SENIOR_RIGHT)
  return roleSlugs.every((slug) => ASSIGNABLE_ROLE_SLUGS.includes(slug)
    || (senior && !PLATFORM_ROLE_SLUGS.includes(slug)))
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

/** The protected role `targetId` holds in `orgId`, if any. */
async function protectedRoleOf(targetId: string, orgId: string): Promise<string | null> {
  for (const slug of await roleSlugsFor(targetId, orgId)) {
    if (PROTECTED_ROLE_SLUGS.has(slug)) return slug
  }
  return null
}

/**
 * May `actorId` delete `targetId` in `orgId`?
 *
 * They must hold `user:delete` there. The System Administrator (the wildcard)
 * passes the membership and group tests on the actor side — its remit is every
 * organisation — and is still bound by the target one: a delete is performed
 * upon somebody who belongs somewhere.
 */
export async function canDeleteUser(
  actorId: string,
  targetId: string,
  orgId: string,
): Promise<DeleteCheck> {
  const subject = await resolveSubject(actorId)
  if (!can(subject, orgId, 'user:delete')) return { ok: false, reason: 'wrong_role' }

  const platformAdmin = can(subject, orgId, WILDCARD)
  if (!platformAdmin && !(await isMemberOf(actorId, orgId))) {
    return { ok: false, reason: 'not_a_member' }
  }

  if (!(await isMemberOf(targetId, orgId))) return { ok: false, reason: 'not_a_member' }

  if (platformAdmin) return { ok: true, platformAdmin: true }

  /**
   * Same group, as well as same organisation.
   *
   * Checked here and not only on the roster, because narrowing a LIST while
   * leaving the action open is not a rule — it is a filter, and an id is easy
   * to come by. `groupScopeFor` resolves the caller's active group memberships
   * on every request, so this is an enforced boundary rather than a filter.
   */
  const scope = await groupScopeFor(actorId, orgId)
  if (!scope.unscoped) {
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: {
        groups: {
          where: { group: { organisations: { some: { organisationId: orgId } } } },
          select: { groupId: true },
        },
      },
    })
    const sharesGroup = target
      && scope.groupIds.length > 0
      && target.groups.some(({ groupId }) => scope.groupIds.includes(groupId))
    if (!sharesGroup) {
      return { ok: false, reason: 'other_group' }
    }
  }

  if (!can(subject, orgId, MANAGE_PROTECTED_RIGHT)) {
    const blockedBy = await protectedRoleOf(targetId, orgId)
    if (blockedBy) return { ok: false, reason: 'protected', blockedBy }
  }
  return { ok: true, platformAdmin: false }
}

/**
 * May `actorId` change `targetId`'s profile, status, membership, groups or
 * roles? Anybody may, as far as their route's own right goes, unless the
 * target holds a protected role and the actor lacks `user:manage_protected`.
 */
export async function canEditUser(
  actorId: string,
  targetId: string,
  orgId: string,
): Promise<EditCheck> {
  if (can(await resolveSubject(actorId), orgId, MANAGE_PROTECTED_RIGHT)) return { ok: true }
  const blockedBy = await protectedRoleOf(targetId, orgId)
  return blockedBy ? { ok: false, blockedBy } : { ok: true }
}
