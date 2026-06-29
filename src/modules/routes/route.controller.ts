import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './route.repository.js'
import type { CreateRoute, UpdateRoute, RouteListQuery } from './route.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.findAll(p(req, 'orgId'), req.query as unknown as RouteListQuery)
    sendSuccess(res, result.data, 200, { cursor: result.cursor, hasNextPage: result.hasNextPage })
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    const route = await repo.create(p(req, 'orgId'), req.body as CreateRoute)
    sendSuccess(res, route, 201)
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    const route = await repo.findById(p(req, 'routeId'), p(req, 'orgId'))
    if (!route) throw new NotFoundError('Route not found')
    sendSuccess(res, route)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    const route = await repo.update(p(req, 'routeId'), p(req, 'orgId'), req.body as UpdateRoute)
    if (!route) throw new NotFoundError('Route not found')
    sendSuccess(res, route)
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    const deleted = await repo.remove(p(req, 'routeId'), p(req, 'orgId'))
    if (!deleted) throw new NotFoundError('Route not found')
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}
