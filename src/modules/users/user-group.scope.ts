/**
 * Which people an administrator may administer.
 *
 * The organisation half of that question was already answered — the roster's
 * `reachable` clause in user.repository admits a person on their home
 * organisation or a live membership. This is the other half: WITHIN a
 * reachable organisation, an `admin` or `system_admin` reaches only accounts
 * in their own group.
 *
 * ## Three rules, and each of them is a decision somebody made
 *
 *   - The PLATFORM role is unscoped. `super_admin` holds a role with
 *     `organisation_id NULL` and already reaches every tenant without a
 *     membership; scoping it too is how an operator locks themselves out of
 *     their own system with nobody left who can put it right. `isPlatform`
 *     comes from lib/authz/subject, so this cannot drift from the definition
 *     the rest of authorization uses.
 *
 *   - Everyone else is scoped to people sharing at least one of their groups
 *     in the current organisation.
 *
 *   - An account with NO group reaches nobody, and is reached by nobody but
 *     the platform administrator. This is fail-closed by design.
 *
 * ## Operational consequence
 *
 * Group boundaries are always enforced. Assign administrators and managers to
 * their groups before granting them user-management access; an account with no
 * group cannot see or administer grouped users.
 */

import { prisma } from '../../lib/prisma.js'
import { resolveSubject } from '../../lib/authz/subject.js'

/**
 * `unscoped` — every group, which is the platform administrator.
 * `groupIds` — groups in the current organisation. An empty list reaches no
 * accounts because an administrator with no group shares no group.
 */
export type GroupScope =
  | { unscoped: true; groupIds?: undefined }
  | { unscoped: false; groupIds: string[] }

/** Nothing is narrowed. */
export const UNSCOPED: GroupScope = { unscoped: true }

/**
 * The group scope for this caller.
 */
export async function groupScopeFor(actorUserId: string | undefined, orgId: string): Promise<GroupScope> {
  return prospectiveScope(actorUserId, orgId)
}

/**
 * The `where` fragment for this scope — spread into a Prisma filter.
 *
 * `{}` when unscoped. Otherwise the user must share at least one group with
 * the caller.
 */
export function groupWhere(scope: GroupScope) {
  if (scope.unscoped) return {}
  return scope.groupIds.length > 0
    ? { groups: { some: { groupId: { in: scope.groupIds } } } }
    : { id: { in: [] } }
}

/**
 * The groups this caller belongs to within this organisation.
 */
export async function prospectiveScope(actorUserId: string | undefined, orgId: string): Promise<GroupScope> {
  // No identified caller cannot mean "see everything". Every route that
  // reaches here is behind requirePermissionStrict, so this guards a future
  // caller rather than a live path — but it must fail closed regardless.
  if (!actorUserId) return { unscoped: false, groupIds: [] }

  const subject = await resolveSubject(actorUserId)
  if (subject.isPlatform) return UNSCOPED

  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: {
      groups: {
        where: { group: { organisations: { some: { organisationId: orgId } } } },
        select: { groupId: true },
      },
    },
  })
  return { unscoped: false, groupIds: [...new Set(actor?.groups.map(({ groupId }) => groupId) ?? [])].sort() }
}

/**
 * A stable key for the roster cache variant.
 *
 * NOT cosmetic. The roster is cached in Redis under
 * `org:version:page:limit:status:access` (modules/users/roster.cache), which
 * carries no caller dimension at all — so the moment the roster differs per
 * group, two administrators in different groups share one cache entry and
 * whichever asks first serves the other their people. 60-second TTL, no error,
 * nothing in a log. This key is what keeps them apart.
 */
export function groupCacheKey(scope: GroupScope): string {
  // A group id is PREFIXED rather than used bare, so it can never collide
  // with either sentinel. Bare, a group whose id happened to be the string
  // "all" would be handed the platform administrator's roster — cuids cannot
  // be that word, so it would have been safe by luck, and a key scheme that
  // is safe by luck is one nobody can change with confidence.
  if (scope.unscoped) return 'all'
  return scope.groupIds.length === 0 ? 'none' : `g:${[...scope.groupIds].sort().join(',')}`
}
