import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './organisation.service.js'
import type { CreateOrgDto, UpdateOrgDto, ListOrgQuery } from './organisation.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listOrganisations(req.query as unknown as ListOrgQuery)
    sendSuccess(res, data, 200, { total, page: Number(req.query['page']), limit: Number(req.query['limit']) })
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    const org = await service.getOrganisation(p(req, 'id'))
    sendSuccess(res, org)
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    const org = await service.createOrganisation(req.body as CreateOrgDto)
    sendSuccess(res, org, 201)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    const org = await service.updateOrganisation(p(req, 'id'), req.body as UpdateOrgDto)
    sendSuccess(res, org)
  } catch (err) { next(err) }
}
