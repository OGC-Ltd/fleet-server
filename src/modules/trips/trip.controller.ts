import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './trip.service.js'
import type { CreateTripDto, ListTripQuery } from './trip.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.listTrips(p(req, 'orgId'), req.query as unknown as ListTripQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getTrip(p(req, 'orgId'), p(req, 'tripId')))
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createTrip(req.body as CreateTripDto), 201)
  } catch (err) { next(err) }
}
