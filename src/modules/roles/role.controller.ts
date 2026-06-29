import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './role.service.js'
import type { CreateRoleDto, UpdateRoleDto, PermissionAssignDto, ListQuery } from './role.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listRoles(p(req, 'orgId'), req.query as unknown as ListQuery)
    sendSuccess(res, data, 200, { total, page: Number(req.query['page']), limit: Number(req.query['limit']) })
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getRole(p(req, 'orgId'), p(req, 'roleId')))
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createRole(p(req, 'orgId'), req.body as CreateRoleDto), 201)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.updateRole(p(req, 'orgId'), p(req, 'roleId'), req.body as UpdateRoleDto))
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await service.deleteRole(p(req, 'orgId'), p(req, 'roleId'))
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

export const addPermission: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.addPermissionToRole(p(req, 'orgId'), p(req, 'roleId'), req.body as PermissionAssignDto), 201)
  } catch (err) { next(err) }
}

export const removePermission: RequestHandler = async (req, res, next) => {
  try {
    await service.removePermissionFromRole(p(req, 'orgId'), p(req, 'roleId'), p(req, 'permissionId'))
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

export const listPermissions: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listPermissions(req.query as unknown as ListQuery)
    sendSuccess(res, data, 200, { total, page: Number(req.query['page']), limit: Number(req.query['limit']) })
  } catch (err) { next(err) }
}
