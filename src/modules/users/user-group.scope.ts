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
 *   - Everyone else is scoped to the group on their own row.
 *
 *   - An account with NO group reaches nobody, and is reached by nobody but
 *     the platform administrator. Fail closed, chosen deliberately: a domain
 *     rule that was never written, or was written with a typo, then shows up
 *     as somebody seeing an empty roster rather than as silent org-wide
 *     visibility. The first is a phone call; the second is a breach nobody
 *     reports.
 *
 * ## Why it ships disabled
 *
 * That third rule has a sharp edge. An administrator whose own address matches
 * no rule sees NOBODY, and a lockout found by an operator is worse than one
 * found in a log. So `USER_GROUP_ENFORCE` gates it the way `AUTHZ_ENFORCE`
 * gates permissions: off means compute the scope, log what it would have
 * hidden, and hide nothing. See prisma/backfill-user-groups.ts, whose dry run
 * prints the accounts that would be locked out.
 */

import { prisma } from '../../lib/prisma.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { resolveSubject } from '../../lib/authz/subject.js'

/**
 * `unscoped` — every group, which is the platform administrator, and also
 * what everybody gets while the flag is off.
 * `groupId` — that group only. `null` means the caller has no group, which
 * under enforcement matches nothing at all.
 */
export type GroupScope =
  | { unscoped: true; groupId?: undefined }
  | { unscoped: false; groupId: string | null }

/** Nothing is narrowed. The shape callers get in shadow mode and for platform. */
export const UNSCOPED: GroupScope = { unscoped: true }

/**
 * The group scope for this caller — the rule below, plus the flag.
 */
export async function groupScopeFor(actorUserId: string | undefined): Promise<GroupScope> {
  // Shadow mode returns before touching the database, so an unreleased
  // feature costs a comparison rather than two queries per request.
  if (!env.USER_GROUP_ENFORCE) return UNSCOPED
  return prospectiveScope(actorUserId)
}

/**
 * The `where` fragment for this scope — spread into a Prisma filter.
 *
 * `{}` when unscoped, so the caller's query is untouched. Otherwise an exact
 * match on the column, INCLUDING `groupId: null`: an ungrouped administrator
 * matching only other ungrouped rows is the fail-closed rule stated as a
 * query, and it means the platform administrator's own ungrouped accounts stay
 * findable by the one caller who is unscoped anyway.
 */
export function groupWhere(scope: GroupScope): { groupId?: string | null } {
  return scope.unscoped ? {} : { groupId: scope.groupId }
}

/**
 * Would this scope have hidden that row?
 *
 * For shadow mode only. The scope is UNSCOPED while the flag is off, so the
 * caller works out separately what it would have been and reports the
 * difference here rather than acting on it.
 */
export function logShadowHidden(
  actorUserId: string | undefined,
  orgId: string,
  wouldHide: number,
  total: number,
): void {
  if (env.USER_GROUP_ENFORCE || wouldHide === 0) return
  logger.warn(
    { actorUserId, orgId, wouldHide, total },
    'user-group: WOULD HIDE rows from this roster (shadow mode) — showing all of them',
  )
}

/**
 * The scope that WOULD apply if the flag were on.
 *
 * This is the whole of the rule. `groupScopeFor` is this plus the flag, and
 * the two are separate because shadow reporting needs to know what the scope
 * WOULD have been while the live path stays unnarrowed — the point of shadow
 * mode is that nothing is hidden yet.
 */
export async function prospectiveScope(actorUserId: string | undefined): Promise<GroupScope> {
  // No identified caller cannot mean "see everything". Every route that
  // reaches here is behind requirePermissionStrict, so this guards a future
  // caller rather than a live path — but it must fail closed regardless.
  if (!actorUserId) return { unscoped: false, groupId: null }

  const subject = await resolveSubject(actorUserId)
  if (subject.isPlatform) return UNSCOPED

  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { groupId: true },
  })
  return { unscoped: false, groupId: actor?.groupId ?? null }
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
  return scope.groupId === null ? 'none' : `g:${scope.groupId}`
}
