import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './fuel.service.js'
import type { CreateFillingDto, ListFillingQuery, CreateTheftDto, ListTheftQuery } from './fuel.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const listFillings: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.listFillings(p(req, 'orgId'), req.query as unknown as ListFillingQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const getFilling: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getFilling(p(req, 'orgId'), p(req, 'fillingId')))
  } catch (err) { next(err) }
}

export const createFilling: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createFilling(req.body as CreateFillingDto), 201)
  } catch (err) { next(err) }
}

export const listThefts: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.listThefts(p(req, 'orgId'), req.query as unknown as ListTheftQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const getTheft: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getTheft(p(req, 'orgId'), p(req, 'theftId')))
  } catch (err) { next(err) }
}

export const createTheft: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createTheft(req.body as CreateTheftDto), 201)
  } catch (err) { next(err) }
}
