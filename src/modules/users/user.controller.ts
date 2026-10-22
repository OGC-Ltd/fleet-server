import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './user.service.js'
import * as repo from './user.repository.js'
import * as provisioning from './provisioning.service.js'
import * as account from '../account/account.service.js'
import { prisma } from '../../lib/prisma.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery, AssignRoleDto,
              ProvisionUserDto, OrgProvisionUserDto, SetMembershipDto,
              SetUserStatusDto, SetUserRoleDto } from './user.schema.js'
import { ASSIGNABLE_ROLE_SLUGS, WILDCARD } from '../../lib/permissions.js'
import { NotFoundError, BadRequestError, ForbiddenError } from '../../core/errors/errors.js'
import { resolveSubject, can, canReachOrg } from '../../lib/authz/subject.js'
import { canDeleteUser } from './user.authz.js'
import { groupScopeFor } from './user-group.scope.js'
import { forgetUser } from '../../middleware/auth.js'
import * as authService from '../auth/auth.service.js'
import { invalidateSubject } from '../../lib/authz/subject.js'
import { invalidateRosterForUser } from './roster.cache.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

/**
 * May this caller grant access to every one of these organisations?
 *
 * `requirePermissionStrict` grades the organisation in the PATH and nothing
 * else, which is right for a single-org route and not enough once a request
 * can name others. Holding user:create at one site says nothing about a second
 * — without this, an admin at Sukari could add somebody to Mufindi.
 *
 * A platform role satisfies it everywhere, which is what platform:admin means.
 */
async function assertCanGrantOrgs(userId: string, orgIds: string[]): Promise<void> {
  const subject = await resolveSubject(userId)
  const refused = orgIds.filter(
    (id) => !(canReachOrg(subject, id) && can(subject, id, 'user:create')),
  )
  if (refused.length) {
    throw new ForbiddenError(
      `Missing permission: user:create in ${refused.join(', ')}`,
    )
  }
}



/**
 * May this caller hand out a PLATFORM role?
 *
 * A platform role (organisation_id NULL) reaches every tenant, so granting one
 * is not an organisation-level act. Only somebody who already holds
 * `platform:admin` may do it — a System Administrator appointing another. An
 * organisation administrator, however complete their power inside their own
 * tenant, cannot, and is never even shown the option.
 *
 * Deliberately checks the permission rather than `subject.isPlatform`:
 * `director` is also a platform role and must not be able to appoint a System
 * Administrator.
 */
async function callerMayGrantPlatformRoles(userId: string | undefined, orgId: string): Promise<boolean> {
  if (!userId) return false
  return can(await resolveSubject(userId), orgId, WILDCARD)
}

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listUsers(
      p(req, 'orgId'), req.query as unknown as ListUserQuery, req.user?.id,
    )
    sendSuccess(res, data, 200, { total, page: Number(req.query['page']), limit: Number(req.query['limit']) })
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getUser(p(req, 'orgId'), p(req, 'userId'), req.user?.id))
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createUser(p(req, 'orgId'), req.body as CreateUserDto), 201)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.updateUser(p(req, 'orgId'), p(req, 'userId'), req.body as UpdateUserDto, req.user?.id))
  } catch (err) { next(err) }
}

/**
 * The role rule in front of both deletes.
 *
 * `user:delete` answers "may this person remove people". It cannot answer "may
 * they remove THIS person", which is the half the operator specified: an admin
 * may not delete a system administrator, the platform administrator, a
 * director or a manager. See users/user.authz for why that is a rule about
 * auditors rather than about rank.
 *
 * In the controller rather than the service because BOTH deletes need it and
 * they are two different services apart — soft and permanent — with
 * different refusals of their own underneath.
 */
async function assertMayDelete(req: Parameters<RequestHandler>[0]): Promise<void> {
  const orgId = p(req, 'orgId')
  const targetId = p(req, 'userId')
  const actorId = req.user?.id
  if (!actorId) throw new ForbiddenError('Not signed in')

  const verdict = await canDeleteUser(actorId, targetId, orgId)
  if (verdict.ok) return

  if (verdict.reason === 'protected') {
    throw new ForbiddenError(
      `An administrator cannot delete a ${ROLE_WORD[verdict.blockedBy ?? ''] ?? 'more senior'} account. `
      + 'Ask the platform administrator.',
    )
  }
  if (verdict.reason === 'not_a_member') {
    throw new ForbiddenError('You can only delete accounts in an organisation you belong to')
  }
  if (verdict.reason === 'other_group') {
    throw new ForbiddenError('You can only delete accounts in your group')
  }
  throw new ForbiddenError('Only an administrator of this organisation can delete accounts')
}

/** For the refusal sentence. The two System Administrator slugs share a name. */
const ROLE_WORD: Record<string, string> = {
  super_admin:  'platform administrator',
  system_admin: 'system administrator',
  admin:        'system administrator',
  director:     'director',
  manager:      'manager',
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await assertMayDelete(req)
    await service.deleteUser(p(req, 'orgId'), p(req, 'userId'), req.user?.id)
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

/**
 * Destroy the account, rather than stamping it deleted.
 *
 * A body, not a 204: the roster page reports what was actually removed, and
 * "the account, its 2 role grants and its 1 session" is the sentence that
 * makes a permanent delete legible after the fact. There is nothing else left
 * to look at.
 */
export const purge: RequestHandler = async (req, res, next) => {
  try {
    await assertMayDelete(req)
    sendSuccess(res, await service.purgeUser(p(req, 'orgId'), p(req, 'userId'), req.user?.id))
  } catch (err) { next(err) }
}

export const assignRole: RequestHandler = async (req, res, next) => {
  try {
    const result = await service.assignRoleToUser(p(req, 'orgId'), p(req, 'userId'), req.body as AssignRoleDto, req.user?.id)
    sendSuccess(res, result, 201)
  } catch (err) { next(err) }
}

export const revokeRole: RequestHandler = async (req, res, next) => {
  try {
    const result = await service.revokeRoleFromUser(p(req, 'orgId'), p(req, 'userId'), p(req, 'roleId'), req.user?.id)
    sendSuccess(res, result)
  } catch (err) { next(err) }
}


// ── Provisioning ───────────────────────────────────────────────────────────
//
// Creating a person and deciding what they may reach are one act, not two: an
// account with no membership can sign in and see nothing, which reads as a
// broken login rather than as a half-finished setup.

/**
 * Platform: create a user across any number of organisations, with a different
 * role in each. Guarded by `user:create` on a route with no :orgId, which
 * requirePermission admits only for a platform role.
 */
export const provisionAcrossOrgs: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as ProvisionUserDto
    // No `grantedById` restriction: this path is reached only by a platform
    // role, which is the one thing allowed to hand out platform roles.
    const { user } = await provisioning.provisionUser(dto, { allowPlatformRoles: true })
    const memberships = await provisioning.listMemberships(user!.id)
    sendSuccess(res, { ...user, memberships }, 201)
  } catch (err) { next(err) }
}

/**
 * Organisation admin: create a user in THIS organisation and nowhere else.
 *
 * The organisation comes from the path and `restrictToOrgId` pins it, so a body
 * naming another tenant is refused rather than filtered.
 */
export const provisionInOrg: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')
    const b = req.body as OrgProvisionUserDto

    // The path organisation, plus any extras the caller asked for — dropping a
    // duplicate of the path org so naming it twice is harmless rather than a
    // conflicting second membership.
    const extras = b.memberships.filter((m) => m.organisationId !== orgId)
    const requested = [
      {
        organisationId:  orgId,
        roleSlugs:       b.roleSlugs,
        allVehicles:     b.allVehicles,
        vehicleIds:      b.vehicleIds,
        vehicleGroupIds: b.vehicleGroupIds,
      },
      ...extras.map((m) => ({
        organisationId:  m.organisationId,
        roleSlugs:       m.roleSlugs,
        allVehicles:     m.allVehicles,
        vehicleIds:      [] as string[],
        vehicleGroupIds: [] as string[],
      })),
    ]

    // requirePermissionStrict only graded the PATH organisation. Every extra
    // one has to be checked too, or user:create at a site the caller does
    // administer would let them grant access to one they do not.
    if (extras.length) await assertCanGrantOrgs(req.user!.id, extras.map((m) => m.organisationId))

    const allowPlatformRoles = await callerMayGrantPlatformRoles(req.user?.id, orgId)

    // No `password` — an org admin invites rather than setting a password for
    // somebody else. See orgProvisionUserSchema for why that field is gone.
    const { user, created, hadPassword } = await provisioning.provisionUser(
      {
        fullName: b.fullName, email: b.email, phone: b.phone, employeeId: b.employeeId,
        memberships: requested,
      },
      // No restrictToOrgId when extra organisations are in play: the check
      // above has already established the caller may grant each of them, and
      // the single-org restriction would refuse them all.
      //
      // allowPlatformRoles is an EXPLICIT capability, never inferred from
      // restrictToOrgId — that inference was a real hole once, because the
      // multi-org branch has to drop restrictToOrgId and silently re-permitted
      // platform roles by doing so. It is true here only for a caller who
      // already holds platform:admin, so a System Administrator can appoint
      // another and an organisation administrator cannot.
      extras.length
        ? { grantedById: req.user?.id, allowPlatformRoles }
        : { restrictToOrgId: orgId, grantedById: req.user?.id, allowPlatformRoles },
    )
    const memberships = await provisioning.listMemberships(user!.id)

    // Invite only an account that cannot already sign in. Sending a
    // set-password link to somebody who HAS a password would let anyone who
    // can guess an email address take over that account through this route.
    let invite: { sent: boolean; reason?: string } = { sent: false, reason: 'not-requested' }
    if (b.sendInvite && !hadPassword) {
      const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true } })
      invite = await account.sendInvite(
        { id: user!.id, email: user!.email, fullName: user!.fullName },
        org?.name ?? 'your organisation',
        { roleName: b.roleSlugs[0], createdById: req.user?.id ?? null, ip: req.ip ?? null },
      )
    } else if (hadPassword) {
      invite = { sent: false, reason: 'account-already-active' }
    }

    // `created` and `invite` are in the body because the admin UI has to say
    // what actually happened: an invite that did not send leaves the person
    // with no way in at all, and a green tick would hide that.
    sendSuccess(res, { ...user, memberships, created, invite }, 201)
  } catch (err) { next(err) }
}

export const listUserMemberships: RequestHandler = async (req, res, next) => {
  try {
    // The answer spans every organisation this person reaches, which is the
    // point of it — but WHO may ask is still this organisation's question,
    // and it was not being asked at all. Same gate as the roster.
    await reachableOrThrow(req, p(req, 'orgId'), p(req, 'userId'))
    sendSuccess(res, await provisioning.listMemberships(p(req, 'userId')))
  } catch (err) { next(err) }
}

/** Set this user's roles and vehicle scope for the organisation in the path. */
export const putMembership: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')
    const b = req.body as SetMembershipDto
    // Group only — see sameGroupOrThrow. This route ADDS an organisation to
    // somebody who may not be in it yet, so it cannot require reachability.
    await sameGroupOrThrow(req, p(req, 'userId'))
    const result = await provisioning.setMembership(
      p(req, 'userId'),
      { organisationId: orgId, ...b },
      {
        restrictToOrgId: orgId,
        grantedById: req.user?.id,
        // Same rule as provisioning: only a platform:admin may grant a role
        // that reaches every organisation.
        allowPlatformRoles: await callerMayGrantPlatformRoles(req.user?.id, orgId),
      },
    )
    sendSuccess(res, result)
  } catch (err) { next(err) }
}

export const deleteMembership: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')
    // Same gate as setUserRole above: revoking a membership takes access
    // away, and a bare user id must not reach outside the caller's group.
    await reachableOrThrow(req, orgId, p(req, 'userId'))
    const result = await provisioning.revokeMembership(p(req, 'userId'), orgId, { restrictToOrgId: orgId })
    sendSuccess(res, result)
  } catch (err) { next(err) }
}

/**
 * The roles this organisation can hand out.
 *
 * Every role the ROLES TABLE holds for this organisation — the database is the
 * source of truth, not a list in application code. An earlier cut also filtered
 * to the slugs in ROLE_DEFINITIONS, which meant a role an operator added by
 * hand simply never appeared in the picker and there was nothing on screen to
 * explain why.
 *
 * Platform roles are still excluded, and by the query rather than by a list:
 * theirs is `organisation_id IS NULL`, which cannot match an equality filter on
 * one organisation. That is not cosmetic — applyMembership REFUSES a platform
 * role on this route, so offering one would be offering a guaranteed failure.
 *
 * The catalogue roles are ordered first because they are the ones an admin is
 * usually looking for; the rest follow alphabetically rather than being hidden.
 */
export const listAssignableRoles: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')

    /**
     * What an administrator may hand out here.
     *
     * Two sources, unioned, and the second one matters more than it looks:
     *
     *   - the catalogue in lib/permissions, which is the list the operator
     *     named, in the order they named it;
     *   - any role somebody in this organisation ACTUALLY HOLDS, catalogue or
     *     not.
     *
     * The second arm exists because the edit form sends the complete set of
     * roles a person should have, and the server revokes whatever is missing
     * from it. A role held by somebody but absent from the picker could not be
     * re-sent, so opening their row and saving anything at all would silently
     * strip it. Offering it keeps the form honest about what it is about to
     * write.
     *
     * It also keeps the ~40 legacy seeded roles out of the picker while
     * nobody holds them, which is the whole reason the catalogue is narrower
     * than the roles table.
     */
    // A platform role belongs to NO organisation, so it can never match the
    // org-scoped queries below — which is why System Administrator was absent
    // from every picker. It is offered here only to a caller who already holds
    // platform:admin, and `platform: true` travels with it so the UI can say
    // what it is: a grant that reaches every organisation, made from inside
    // one of them.
    const mayGrantPlatform = await callerMayGrantPlatformRoles(req.user?.id, orgId)

    const [catalogue, inUse, platform] = await Promise.all([
      prisma.role.findMany({
        where:  { organisationId: orgId, slug: { in: ASSIGNABLE_ROLE_SLUGS } },
        select: { id: true, slug: true, name: true },
      }),
      prisma.role.findMany({
        where: {
          organisationId: orgId,
          userRoles: { some: { revokedAt: null, user: { deletedAt: null } } },
        },
        select: { id: true, slug: true, name: true },
      }),
      mayGrantPlatform
        ? prisma.role.findMany({
            where:  { organisationId: null, slug: { in: ASSIGNABLE_ROLE_SLUGS } },
            select: { id: true, slug: true, name: true },
          })
        : Promise.resolve([]),
    ])

    const platformIds = new Set(platform.map((r) => r.id))
    const roles = [...new Map([...catalogue, ...inUse, ...platform].map((r) => [r.id, r])).values()]
      .map((r) => ({ ...r, platform: platformIds.has(r.id) }))

    const rank = (slug: string) => {
      const i = ASSIGNABLE_ROLE_SLUGS.indexOf(slug)
      return i === -1 ? ASSIGNABLE_ROLE_SLUGS.length : i
    }
    roles.sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name))

    sendSuccess(res, { roles }, 200)
  } catch (err) { next(err) }
}

/**
 * Send the invitation again.
 *
 * Mints a fresh link, which revokes the previous one — so a forwarded or
 * shoulder-surfed old link stops working the moment a new one is asked for.
 * Refuses outright for an account that already has a password: that is not a
 * re-invitation, it is a password reset for somebody else, and the person
 * concerned can ask for one themselves.
 */
/**
 * The person this route names, IF the caller may reach them.
 *
 * Organisation and group in one place, because three routes here were reading
 * `{ id, deletedAt: null }` and nothing else: a bare id out of any tenant and
 * any group would resend that person's invitation, or suspend them, or read
 * back their address. Pre-existing, and not something to leave standing once
 * the roster is narrowed — a rule that only narrows the LIST is a filter, and
 * the id is right there in the URL.
 *
 * `findReachable` is the roster's own reachability test (home organisation or
 * a live membership), so this cannot drift from what the list shows. The
 * group scope is unscoped until USER_GROUP_ENFORCE is on.
 */
/**
 * The group gate ALONE, for the two routes that may legitimately name
 * somebody who is not in this organisation yet.
 *
 * `PUT /:userId/memberships` exists precisely to ADD an organisation to a
 * person who was not in it ("adding somebody to a second site means calling
 * this with that site's id"), and `PATCH /:userId/role` goes through the same
 * `setMembership`. Putting `reachableOrThrow` on either would 404 the case
 * the route was written for — the caller's right to the organisation is
 * already checked by `requirePermissionStrict` on `:orgId`, and it is the
 * TARGET's organisation that must stay open here.
 *
 * The group is a different question and does apply: an administrator must not
 * pull somebody out of another group into their own. Unscoped, and therefore
 * inert, until USER_GROUP_ENFORCE is on.
 */
async function sameGroupOrThrow(req: Parameters<RequestHandler>[0], userId: string): Promise<void> {
  const scope = await groupScopeFor(req.user?.id, p(req, 'orgId'))
  if (scope.unscoped) return
  const target = await prisma.user.findFirst({
    where:  { id: userId, deletedAt: null },
    select: {
      groups: {
        where: { group: { organisationId: p(req, 'orgId') } },
        select: { groupId: true },
      },
    },
  })
  // A target that does not exist is the route's own 404 to raise, not this
  // gate's — it knows what it was looking for and this does not.
  if (target && !(
    scope.groupIds.length === 0
      ? target.groups.length === 0
      : target.groups.some(({ groupId }) => scope.groupIds.includes(groupId))
  )) {
    throw new ForbiddenError('You can only manage accounts in your group')
  }
}

async function reachableOrThrow(req: Parameters<RequestHandler>[0], orgId: string, userId: string) {
  const found = await repo.findReachable(orgId, userId, await groupScopeFor(req.user?.id, orgId))
  if (!found) throw new NotFoundError('User')
  return found
}

export const resendInvite: RequestHandler = async (req, res, next) => {
  try {
    const orgId  = p(req, 'orgId')
    const userId = p(req, 'userId')

    await reachableOrThrow(req, orgId, userId)
    const user = await prisma.user.findFirst({
      where:  { id: userId, deletedAt: null },
      select: { id: true, email: true, fullName: true, passwordHash: true },
    })
    if (!user) throw new NotFoundError('User')
    if (user.passwordHash) {
      throw new BadRequestError('This account already has a password. Ask them to use "Forgotten your password?" instead.')
    }

    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true } })
    const invite = await account.sendInvite(
      { id: user.id, email: user.email, fullName: user.fullName },
      org?.name ?? 'your organisation',
      { createdById: req.user?.id ?? null, ip: req.ip ?? null },
    )
    // The roster shows when an invitation was last sent and whether it is
    // still live, so a resend changes what it should be displaying.
    await invalidateRosterForUser(userId, orgId)
    sendSuccess(res, { invite }, 200)
  } catch (err) { next(err) }
}

/**
 * Suspend or reactivate somebody.
 *
 * Suspending REVOKES THEIR SESSIONS. Without that the flag only takes effect
 * when their access token next expires — up to fifteen minutes during which a
 * person you have just suspended carries on working, which is not what anybody
 * pressing that button believes they are doing.
 */
export const setUserStatus: RequestHandler = async (req, res, next) => {
  try {
    const orgId  = p(req, 'orgId')
    const userId = p(req, 'userId')
    const { status } = req.body as SetUserStatusDto

    const existing = await reachableOrThrow(req, orgId, userId)

    // Suspending yourself locks you out of the tab you are standing in, with
    // no way back that does not need another admin.
    if (userId === req.user?.id) {
      throw new BadRequestError('You cannot change your own status')
    }

    const user = await prisma.user.update({
      where:  { id: userId },
      data:   { status },
      select: { id: true, fullName: true, email: true, status: true },
    })

    if (status === 'SUSPENDED') {
      await authService.revokeAllSessions(userId, 'account suspended')
    }
    forgetUser(existing.email)
    await invalidateSubject(userId)
    // Status is the column the roster leads with; an admin who suspends
    // somebody and still sees ACTIVE will do it again.
    await invalidateRosterForUser(userId, orgId)

    sendSuccess(res, { user }, 200)
  } catch (err) { next(err) }
}

/**
 * Replace somebody's roles in THIS organisation.
 *
 * Goes through setMembership rather than the role endpoints below because it
 * is org-scoped by construction: setMembership refuses a membership outside
 * `restrictToOrgId`, and applyMembership refuses platform roles on that path.
 * It also invalidates the authz cache, which the older assignRoleToUser and
 * revokeRoleFromUser do not — a gap worth closing separately.
 */
export const setUserRole: RequestHandler = async (req, res, next) => {
  try {
    const orgId  = p(req, 'orgId')
    const userId = p(req, 'userId')
    const { roleSlugs } = req.body as SetUserRoleDto

    if (userId === req.user?.id) {
      throw new BadRequestError('You cannot change your own roles')
    }

    // Setting somebody's roles is the sharpest thing on this route file — it
    // changes what they can DO. Group only, for the same reason as
    // putMembership: this goes through `setMembership`, which adds the
    // organisation when it is missing.
    await sameGroupOrThrow(req, userId)

    const memberships = await provisioning.setMembership(
      userId,
      // allVehicles true and empty scope lists: this endpoint changes ROLES,
      // and passing a narrower scope here would silently widen or clear a
      // vehicle restriction set elsewhere. Vehicle scope has its own route.
      { organisationId: orgId, roleSlugs, allVehicles: true, vehicleIds: [], vehicleGroupIds: [] },
      {
        restrictToOrgId: orgId,
        grantedById: req.user?.id,
        allowPlatformRoles: await callerMayGrantPlatformRoles(req.user?.id, orgId),
      },
    )
    sendSuccess(res, { memberships }, 200)
  } catch (err) { next(err) }
}
