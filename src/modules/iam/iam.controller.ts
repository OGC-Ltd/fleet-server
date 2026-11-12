import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import * as service from './iam.service.js'
import type { ListUsersQuery, SetFleetDto, SetGrantsDto } from './iam.schema.js'

export const catalogue: RequestHandler = (_req, res, next) => {
  try {
    sendSuccess(res, service.catalogue())
  } catch (err) { next(err) }
}

export const listUsers: RequestHandler = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListUsersQuery
    const { data, total } = await service.listUsers(query)
    sendSuccess(res, data, 200, { total, page: query.page, limit: query.limit })
  } catch (err) { next(err) }
}

export const userAccess: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.userAccess(req.params['userId'] as string))
  } catch (err) { next(err) }
}

export const setGrants: RequestHandler = async (req, res, next) => {
  try {
    const actorId = req.user?.id
    if (!actorId) throw new UnauthorizedError('Not authenticated')
    const { changes } = req.body as SetGrantsDto
    sendSuccess(res, await service.setGrants(actorId, req.params['userId'] as string, changes))
  } catch (err) { next(err) }
}

export const setFleet: RequestHandler = async (req, res, next) => {
  try {
    const actorId = req.user?.id
    if (!actorId) throw new UnauthorizedError('Not authenticated')
    sendSuccess(res, await service.setFleetAccess(actorId, req.params['userId'] as string, req.body as SetFleetDto))
  } catch (err) { next(err) }
}
