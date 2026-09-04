import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './user.service.js'
import * as provisioning from './provisioning.service.js'
import * as account from '../account/account.service.js'
import { prisma } from '../../lib/prisma.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery, AssignRoleDto,
              ProvisionUserDto, OrgProvisionUserDto, SetMembershipDto,
              SetUserStatusDto, SetUserRoleDto } from './user.schema.js'
import { ORG_ROLE_SLUGS } from '../../lib/permissions.js'
import { NotFoundError, BadRequestError, ForbiddenError } from '../../core/errors/errors.js'
import { resolveSubject, can, canReachOrg } from '../../lib/authz/subject.js'
import { forgetUser } from '../../middleware/auth.js'
import * as authService from '../auth/auth.service.js'
import { invalidateSubject } from '../../lib/authz/subject.js'

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


export const list: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listUsers(p(req, 'orgId'), req.query as unknown as ListUserQuery)
    sendSuccess(res, data, 200, { total, page: Number(req.query['page']), limit: Number(req.query['limit']) })
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getUser(p(req, 'orgId'), p(req, 'userId')))
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createUser(p(req, 'orgId'), req.body as CreateUserDto), 201)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.updateUser(p(req, 'orgId'), p(req, 'userId'), req.body as UpdateUserDto))
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await service.deleteUser(p(req, 'orgId'), p(req, 'userId'))
    sendSuccess(res, null, 204)
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
    const result = await service.revokeRoleFromUser(p(req, 'orgId'), p(req, 'userId'), p(req, 'roleId'))
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
      // allowPlatformRoles is absent (false) on BOTH branches: this route may
      // never hand out a platform role, and dropping restrictToOrgId for the
      // multi-org case must not quietly change that. Each extra organisation
      // is authorised separately by assertCanGrantOrgs above.
      extras.length
        ? { grantedById: req.user?.id }
        : { restrictToOrgId: orgId, grantedById: req.user?.id },
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
    sendSuccess(res, await provisioning.listMemberships(p(req, 'userId')))
  } catch (err) { next(err) }
}

/** Set this user's roles and vehicle scope for the organisation in the path. */
export const putMembership: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')
    const b = req.body as SetMembershipDto
    const result = await provisioning.setMembership(
      p(req, 'userId'),
      { organisationId: orgId, ...b },
      { restrictToOrgId: orgId, grantedById: req.user?.id },
    )
    sendSuccess(res, result)
  } catch (err) { next(err) }
}

export const deleteMembership: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')
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
    const roles = await prisma.role.findMany({
      where:   { organisationId: orgId },
      select:  { id: true, slug: true, name: true },
      orderBy: { name: 'asc' },
    })

    const rank = (slug: string) => {
      const i = ORG_ROLE_SLUGS.indexOf(slug)
      return i === -1 ? ORG_ROLE_SLUGS.length : i
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
export const resendInvite: RequestHandler = async (req, res, next) => {
  try {
    const orgId  = p(req, 'orgId')
    const userId = p(req, 'userId')

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
    const userId = p(req, 'userId')
    const { status } = req.body as SetUserStatusDto

    const existing = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null }, select: { id: true, email: true },
    })
    if (!existing) throw new NotFoundError('User')

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

    const memberships = await provisioning.setMembership(
      userId,
      // allVehicles true and empty scope lists: this endpoint changes ROLES,
      // and passing a narrower scope here would silently widen or clear a
      // vehicle restriction set elsewhere. Vehicle scope has its own route.
      { organisationId: orgId, roleSlugs, allVehicles: true, vehicleIds: [], vehicleGroupIds: [] },
      { restrictToOrgId: orgId, grantedById: req.user?.id },
    )
    sendSuccess(res, { memberships }, 200)
  } catch (err) { next(err) }
}
