import type { RequestHandler } from 'express'
import { sendError, sendSuccess } from '../../core/response/response.js'
/* Reads go through the cache, which fronts the service with the same
   signatures and falls through to it for anything it declines to hold — see
   incidents.cache. */
import * as service from './incidents.cache.js'
import type { SummaryQuery, ListQuery, InsightsQuery, DetailsQuery, ReadingsQuery } from './incidents.schema.js'
import { trackerReadings } from './tracker-readings.service.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const speedingSummary: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.speedingSummary(p(req, 'orgId'), req.query as unknown as SummaryQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const speedingList: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.speedingList(p(req, 'orgId'), req.query as unknown as ListQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const speedingInsights: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.speedingInsights(p(req, 'orgId'), req.query as unknown as InsightsQuery))
  } catch (err) { next(err) }
}

export const faultSummary: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.faultSummary(p(req, 'orgId'), req.query as unknown as SummaryQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const faultList: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.faultList(p(req, 'orgId'), req.query as unknown as ListQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

/** GET …/incidents/faults/readings?vehicleId — the unit's tracker readings now, from Wialon. */
export const faultReadings: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as ReadingsQuery
    const out = await trackerReadings(p(req, 'orgId'), q.vehicleId)
    if (!out) { sendError(res, 404, 'Unit not found'); return }
    sendSuccess(res, out)
  } catch (err) { next(err) }
}

/** GET …/incidents/faults/details?from&to[&kind] — the messages in the window, with counts. */
export const faultDetails: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.faultDetails(p(req, 'orgId'), req.query as unknown as DetailsQuery))
  } catch (err) { next(err) }
}

export const faultInsights: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.faultInsights(p(req, 'orgId'), req.query as unknown as InsightsQuery))
  } catch (err) { next(err) }
}
