import { NotFoundError, ConflictError } from '../../core/errors/errors.js'
import * as repo from './user.repository.js'
import { readRoster, writeRoster, invalidateRoster, invalidateRosterForUser } from './roster.cache.js'
import { invalidateSubject } from '../../lib/authz/subject.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery, AssignRoleDto } from './user.schema.js'
import {
  groupScopeFor, prospectiveScope, groupCacheKey, logShadowHidden,
} from './user-group.scope.js'

type Roster = Awaited<ReturnType<typeof repo.findAll>>

/**
 * The roster, from Redis when it is warm and from Postgres when it is not.
 *
 * Every narrowing the caller can apply goes into the variant, because two
 * queries that differ by page or by status filter are two different answers
 * and must not share a key.
 *
 * Dates arrive back from JSON as strings rather than Date objects. That is
 * fine and deliberate here: this value is serialised to JSON on its way out to
 * the client anyway, so the cached round trip produces the same response body
 * as the database one. Nothing between here and the wire does date arithmetic.
 */
export async function listUsers(orgId: string, query: ListUserQuery, actorUserId?: string) {
  const scope = await groupScopeFor(actorUserId, orgId)

  /**
   * The group belongs in the KEY, not merely in the query.
   *
   * This variant had no caller dimension at all, which was right while the
   * roster was the same for every administrator of an organisation. It stopped
   * being right the moment the group narrowed it: two admins in different
   * groups would share one entry, and whichever asked first would serve the
   * other their people for the next sixty seconds — no error, nothing logged,
   * and the wrong answer indistinguishable from the right one.
   */
  const variant =
    `${query.page}:${query.limit}:${query.status ?? 'all'}:${query.access ?? 'all'}` +
    `:g:${groupCacheKey(scope)}`

  const cached = await readRoster<Roster>(orgId, variant)
  if (cached) return cached

  const fresh = await repo.findAll(orgId, query, scope)
  await writeRoster(orgId, variant, fresh)

  // Shadow mode: say what enforcement WOULD have removed, having removed
  // nothing. Only for the roster that the rule actually applies to.
  if (scope.unscoped && query.access === 'system') {
    await reportShadow(orgId, query, actorUserId, fresh.total)
  }
  return fresh
}

/**
 * How much of this roster the group rule would take away.
 *
 * Costs a COUNT on a page the caller already fetched, and only while the
 * feature is off — `prospectiveScope` short-circuits to unscoped for the
 * platform administrator, and `logShadowHidden` returns immediately once
 * enforcement is on. A failure here must never fail the roster: the operator
 * asked for a list of people, not for a rehearsal of a feature flag.
 */
async function reportShadow(
  orgId: string,
  query: ListUserQuery,
  actorUserId: string | undefined,
  total: number,
): Promise<void> {
  try {
    const would = await prospectiveScope(actorUserId, orgId)
    if (would.unscoped) return
    const visible = await repo.countForScope(orgId, query, would)
    logShadowHidden(actorUserId, orgId, total - visible, total)
  } catch {
    /* a rehearsal that fails is still only a rehearsal */
  }
}

export async function getUser(orgId: string, userId: string, actorUserId?: string) {
  const user = await repo.findById(orgId, userId, await groupScopeFor(actorUserId, orgId))
  if (!user) throw new NotFoundError('User')
  return user
}

export async function createUser(orgId: string, dto: CreateUserDto) {
  const user = await repo.create(orgId, dto)
  await invalidateRoster(orgId)
  return user
}

export async function updateUser(orgId: string, userId: string, dto: UpdateUserDto, actorUserId?: string) {
  // Exists, right organisation, AND in the caller's group — the same gate the
  // roster uses, so a row this admin cannot see is a row they cannot edit.
  await getUser(orgId, userId, actorUserId)
  const user = await repo.update(orgId, userId, dto)
  // Every roster they appear in, not just this one — a renamed person is
  // renamed everywhere they have access.
  await invalidateRosterForUser(userId, orgId)
  return user
}

/**
 * Mark an account deleted.
 *
 * ## `findReachable`, not `getUser` — the same correction purgeUser already carries
 *
 * getUser resolves through `findById`, which matches on the home organisation
 * COLUMN alone, while the roster that produced this button lists anybody with a
 * live MEMBERSHIP here too. Measured against the live fleets: of 48 rows across
 * the four organisations' rosters, 35 are people whose account lives in another
 * tenant — and on Mufindi it is ALL TWELVE. Every one of them answered this
 * endpoint with a 404 "User" about somebody plainly on screen, which is why
 * "I cannot delete users" was the correct description of the whole feature.
 *
 * ## A guest is refused, and told what to do instead
 *
 * Not an oversight and not a lesser version of the fix. `deletedAt` is on the
 * USER row, so a soft delete reaches every organisation that person belongs to
 * — exactly the objection purgeUser raises against deleting a guest, and it
 * applies here unchanged. Doing that from a page headed with one site's name,
 * for somebody whose home is another site, is a delete nobody could have
 * predicted from where they clicked. Withdrawing the membership is the action
 * that means what the operator intends, and it is scoped to one organisation.
 *
 * The difference the fix makes is therefore not "guests can now be deleted".
 * It is that the answer changed from a 404 about a person who is visibly there
 * into a sentence naming the right button.
 */
export async function deleteUser(orgId: string, userId: string, actorUserId?: string) {
  const user = await repo.findReachable(orgId, userId, await groupScopeFor(actorUserId, orgId))
  if (!user) throw new NotFoundError('User')

  if (user.organisationId !== orgId) {
    throw new ConflictError(
      'This person belongs to another organisation. Remove their access to this one instead '
      + '— deleting the account would remove them everywhere.',
    )
  }
  // Read their organisations BEFORE the delete: afterwards the row is gone
  // from the roster's point of view and there is nothing left to resolve.
  await invalidateRosterForUser(userId, orgId)
  return repo.softDelete(orgId, userId)
}

/**
 * Destroy the account and everything that only describes it.
 *
 * This is the one write in this module with no undo, so the refusals are the
 * design rather than an afterthought. Four of them, each answering a different
 * way this can be the wrong call:
 *
 *   · YOURSELF. Deleting the account you are signed in as ends the session
 *     that is halfway through the request. Suspending yourself is already
 *     refused elsewhere for the milder version of the same reason.
 *
 *   · A GUEST. `orgId` is the organisation the administrator is looking at,
 *     and a permanent delete reaches every organisation the person belongs to.
 *     Doing that from a page headed with one site's name, for somebody whose
 *     home is another site, is a delete nobody could have predicted from where
 *     they clicked. Withdraw the membership instead — that is what the access
 *     editor does, and it is scoped to exactly one organisation.
 *
 *   · SOMEBODY WITH A HISTORY. Trips, fuel losses, speeding, geofence
 *     violations and vehicle assignments name a driver through a NULLABLE key,
 *     so the database would not block this delete — it would quietly blank the
 *     driver out of every one of those records. A month of incident reports
 *     would keep their totals and lose their subject. So the count is read
 *     first and the delete is refused with the numbers in it.
 *
 *   · SOMEBODY WHO IS NOT THERE. A soft-deleted row is still a row, and
 *     `getUser` is what decides whether this organisation may see it at all.
 *
 * A suspended account is deliberately NOT refused: suspend-then-delete is the
 * sequence an administrator actually performs, and making the first step block
 * the second would be a trap.
 */
export async function purgeUser(orgId: string, userId: string, actorId?: string) {
  /*
   * `findReachable`, not `getUser`.
   *
   * getUser resolves through `findById`, which matches on the home
   * organisation alone — while the roster that produced this button lists
   * anybody with a live MEMBERSHIP here too. So every visiting member reached
   * this function as a 404 "User not found" about a person plainly on screen,
   * and the refusal below — the one that explains what is actually going on
   * and what to do instead — was unreachable code.
   *
   * The narrow lookup is used here rather than widening findById for
   * everything: see the note on findReachable.
   */
  const user = await repo.findReachable(orgId, userId, await groupScopeFor(actorId, orgId))
  if (!user) throw new NotFoundError('User')

  if (actorId && actorId === userId) {
    throw new ConflictError('You cannot permanently delete the account you are signed in as.')
  }

  if (user.organisationId !== orgId) {
    throw new ConflictError(
      'This person belongs to another organisation. Remove their access to this one instead — '
      + 'a permanent delete would remove them everywhere.',
    )
  }

  const held = await repo.countBelongings(userId)

  if (held.operational > 0) {
    const parts = [
      held.trips       ? `${held.trips} trip${held.trips === 1 ? '' : 's'}` : null,
      held.assignments ? `${held.assignments} vehicle assignment${held.assignments === 1 ? '' : 's'}` : null,
      held.speeding    ? `${held.speeding} speeding incident${held.speeding === 1 ? '' : 's'}` : null,
      held.violations  ? `${held.violations} geofence violation${held.violations === 1 ? '' : 's'}` : null,
      held.thefts      ? `${held.thefts} fuel loss${held.thefts === 1 ? '' : 'es'}` : null,
    ].filter(Boolean).join(', ')
    throw new ConflictError(
      `This person has operations history — ${parts} — which would lose its driver if the account were destroyed. `
      + 'Suspend the account instead; it keeps the history and ends every session.',
    )
  }

  // Twice, and both are necessary.
  //
  // BEFORE, because the memberships that answer "which rosters is this person
  // in" are about to be deleted and there is nothing left to resolve them from
  // afterwards. `held.organisationIds` is that answer, read while it existed.
  //
  // AFTER, because the delete is not instantaneous and a roster read landing
  // between the two would re-warm the cache from a database that still holds
  // the row — leaving a cached list containing somebody who no longer exists,
  // with nothing to expire it but its own TTL. The second call needs no new
  // query: it re-uses the ids captured before.
  await invalidateRoster(...held.organisationIds, orgId)

  const deleted = await repo.purge(orgId, userId)

  await invalidateRoster(...held.organisationIds, orgId)

  // Their resolved permissions are cached under their id and would otherwise
  // outlive them — a stale subject for a user who no longer exists.
  await invalidateSubject(userId)

  return { id: deleted.id, fullName: deleted.fullName, email: deleted.email, removed: held }
}

export async function assignRoleToUser(orgId: string, userId: string, dto: AssignRoleDto, assignedById?: string) {
  // `assignedById` IS the caller, so the group gate costs nothing extra here.
  // Granting a role across a group would be the sharpest version of the leak:
  // not reading somebody else's people, but changing what they can do.
  await getUser(orgId, userId, assignedById)
  try {
    const assigned = await repo.assignRole(userId, dto.roleId, assignedById)
    await invalidateRosterForUser(userId, orgId)
    return assigned
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      throw new ConflictError('Role already assigned to this user')
    }
    throw err
  }
}

export async function revokeRoleFromUser(orgId: string, userId: string, roleId: string, actorUserId?: string) {
  await getUser(orgId, userId, actorUserId)
  const result = await repo.revokeRole(userId, roleId)
  if (!result) throw new NotFoundError('Active role assignment')
  await invalidateRosterForUser(userId, orgId)
  return result
}
