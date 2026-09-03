import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './user.service.js'
import * as provisioning from './provisioning.service.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery, AssignRoleDto,
              ProvisionUserDto, OrgProvisionUserDto, SetMembershipDto } from './user.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

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
    const user = await provisioning.provisionUser(dto)
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
    const user = await provisioning.provisionUser(
      {
        fullName: b.fullName, email: b.email, phone: b.phone, employeeId: b.employeeId,
        password: b.password,
        memberships: [{
          organisationId:  orgId,
          roleSlugs:       b.roleSlugs,
          allVehicles:     b.allVehicles,
          vehicleIds:      b.vehicleIds,
          vehicleGroupIds: b.vehicleGroupIds,
        }],
      },
      { restrictToOrgId: orgId, grantedById: req.user?.id },
    )
    const memberships = await provisioning.listMemberships(user!.id)
    sendSuccess(res, { ...user, memberships }, 201)
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
