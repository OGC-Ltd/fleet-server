import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './user.service.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery, AssignRoleDto } from './user.schema.js'

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
