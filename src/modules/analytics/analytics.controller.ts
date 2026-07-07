import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as repo from './analytics.repository.js'
import type { AnalyticsRange, SpeedingQuery, DeliveriesQuery } from './analytics.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const overview: RequestHandler = async (req, res, next) => {
  try {
    const data = await repo.fleetOverview(p(req, 'orgId'))
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const deliveries: RequestHandler = async (req, res, next) => {
  try {
    const data = await repo.deliveriesAnalytics(p(req, 'orgId'), req.query as unknown as DeliveriesQuery)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const fuelEfficiency: RequestHandler = async (req, res, next) => {
  try {
    const data = await repo.fuelEfficiency(p(req, 'orgId'), req.query as unknown as AnalyticsRange)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const speeding: RequestHandler = async (req, res, next) => {
  try {
    const data = await repo.speedingEvents(p(req, 'orgId'), req.query as unknown as SpeedingQuery)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const violationHeatmap: RequestHandler = async (req, res, next) => {
  try {
    const data = await repo.violationHeatmap(p(req, 'orgId'), req.query as unknown as AnalyticsRange)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}
