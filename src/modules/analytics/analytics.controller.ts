import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as repo from './analytics.repository.js'
import { getDriversOverview, DEFAULT_DRIVER_WINDOW_DAYS } from './drivers-overview.cache.js'
import { getDeliveriesAnalytics } from './deliveries.cache.js'
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
    const q = req.query as unknown as DeliveriesQuery
    // Trailing windows serve from the warmed cache; an explicit `to` anchor
    // is an unbounded key space, so it computes live like before.
    const data = q.to
      ? await repo.deliveriesAnalytics(p(req, 'orgId'), q)
      : await getDeliveriesAnalytics(p(req, 'orgId'), q.days)
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

// All three driver endpoints serve from the warmed in-memory overview cache
// (drivers-overview.cache.ts) — the remote DB is never on the request path.

export const driversList: RequestHandler = async (req, res, next) => {
  try {
    const overview = await getDriversOverview(p(req, 'orgId'), DEFAULT_DRIVER_WINDOW_DAYS)
    sendSuccess(res, overview.drivers)
  } catch (err) { next(err) }
}

export const driversOverview: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as DeliveriesQuery
    const data = await getDriversOverview(p(req, 'orgId'), q.days)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const driverAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as DeliveriesQuery
    const overview = await getDriversOverview(p(req, 'orgId'), q.days)
    const cached = overview.details[p(req, 'driverId')]
    // Roster drivers come straight from the cache; anyone else (valid org user
    // who isn't currently assigned) falls back to the live per-driver query.
    const data = cached ?? await repo.driverAnalytics(p(req, 'orgId'), p(req, 'driverId'), q)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}
