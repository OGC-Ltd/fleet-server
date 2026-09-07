import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './incidents.service.js'
import type { SummaryQuery, ListQuery, InsightsQuery } from './incidents.schema.js'

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

export const faultInsights: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.faultInsights(p(req, 'orgId'), req.query as unknown as InsightsQuery))
  } catch (err) { next(err) }
}
