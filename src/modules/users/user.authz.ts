/**
 * Who may delete whom.
 *
 * ## The rule, as the operator stated it
 *
 *   · The platform administrator and an organisation's admin may delete
 *     accounts.
 *   · Admins may delete accounts in their organisation and shared group.
 *   · Only accounts in the same GROUP — see user-group.scope.
 *   · An admin may NOT delete a system administrator, the platform
 *     administrator or a director.
 *
 * The last line is the only one that is not already implied by `user:delete`,
 * and it is the reason this file exists: a permission is a fact about the
 * person clicking, and no permission can express "except against these
 * people". `user:delete` is held only by `admin` and, through the wildcard,
 * by `super_admin`.
 *
 * ## Seniority is the wrong word for it
 *
 * Admins cannot remove protected system administrators or directors. The
 * platform administrator is unrestricted.
 */

import { prisma } from '../../lib/prisma.js'
import type { RequestHandler } from 'express'
import { ForbiddenError, UnauthorizedError } from '../../core/errors/errors.js'
import { groupScopeFor } from './user-group.scope.js'
import { ASSIGNABLE_ROLE_SLUGS } from '../../lib/permissions.js'

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
  'super_admin', 'system_admin', 'admin', 'director',
])

/** Roles an organisation administrator may not edit, including role grants. */
const PROTECTED_FROM_EDIT = new Set<string>([
  'super_admin', 'system_admin', 'admin', 'director',
])

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

/** The role filter required by a supervisor's user roster. */
export async function visibleRoleSlugFor(userId: string, orgId: string): Promise<string | null> {
  const roles = await roleSlugsFor(userId, orgId)
  if (!roles.has('supervisor')) return null
  if (['super_admin', 'director', 'admin', 'manager', 'hr'].some((slug) => roles.has(slug))) return null
  return 'operator'
}

/** A supervisor may open only operator accounts in their organisation. */
export async function canViewUser(actorId: string, targetId: string, orgId: string): Promise<boolean> {
  const actorRoles = await roleSlugsFor(actorId, orgId)
  const broadReader = ['super_admin', 'director', 'admin', 'manager', 'hr']
    .some((slug) => actorRoles.has(slug))
  if (
    actorRoles.has('operator')
    && !broadReader
    && !actorRoles.has('supervisor')
  ) return false
  if (!actorRoles.has('supervisor') || broadReader) return true
  return (await roleSlugsFor(targetId, orgId)).has('operator')
}

/** Operators have no user-directory access, even if stale grants remain. */
export const requireUserReader: RequestHandler = async (req, _res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) throw new UnauthorizedError('Not authenticated')
    const orgParam = req.params['orgId']
    const roles = await roleSlugsFor(userId, typeof orgParam === 'string' ? orgParam : null)
    if (
      roles.has('operator')
      && !['super_admin', 'director', 'admin', 'manager', 'supervisor', 'hr'].some((slug) => roles.has(slug))
    ) {
      throw new ForbiddenError('Operators do not have user-directory access')
    }
    next()
  } catch (err) {
    next(err)
  }
}

/** Only an admin or super admin may perform user-management writes. */
export const requireUserAdministrator: RequestHandler = async (req, _res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) throw new UnauthorizedError('Not authenticated')
    const orgParam = req.params['orgId']
    const orgId = typeof orgParam === 'string' ? orgParam : null
    const roles = await roleSlugsFor(userId, orgId)
    if (roles.has('super_admin') || (orgId !== null && roles.has('admin'))) {
      next()
      return
    }
    throw new ForbiddenError('Only an admin or super admin can manage users')
  } catch (err) {
    next(err)
  }
}

/** Admins may grant only roles explicitly ranked below admin. */
export async function canManageRoleSlugs(
  actorId: string,
  orgId: string,
  roleSlugs: string[],
): Promise<boolean> {
  const actorRoles = await roleSlugsFor(actorId, orgId)
  if (actorRoles.has('super_admin')) return true
  if (!actorRoles.has('admin')) return false
  return roleSlugs.every((slug) => ASSIGNABLE_ROLE_SLUGS.includes(slug))
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
  if (isPlatform) return { ok: true, platformAdmin: true }

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

  const targetRoles = await roleSlugsFor(targetId, orgId)
  for (const slug of targetRoles) {
    if (PROTECTED_FROM_ADMIN.has(slug)) return { ok: false, reason: 'protected', blockedBy: slug }
  }
  return { ok: true, platformAdmin: false }
}

/**
 * Prevent an organisation administrator from changing a protected account's
 * profile, status, membership, group membership, or role grants.
 */
export async function canEditUser(
  actorId: string,
  targetId: string,
  orgId: string,
): Promise<EditCheck> {
  const actorRoles = await roleSlugsFor(actorId, orgId)
  if (actorRoles.has('super_admin')) return { ok: true }

  const targetRoles = await roleSlugsFor(targetId, orgId)
  for (const slug of targetRoles) {
    if (PROTECTED_FROM_EDIT.has(slug)) return { ok: false, blockedBy: slug }
  }
  return { ok: true }
}
