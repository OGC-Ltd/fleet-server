import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { env } from '../../config/env.js'
import * as repo from './analytics.repository.js'
import { getDriversOverview, DEFAULT_DRIVER_WINDOW_DAYS } from './drivers-overview.cache.js'
import { getDeliveriesAnalytics } from './deliveries.cache.js'
import { getFuelConsumption } from './fuel-cost.cache.js'
import { priceFuelConsumption } from './fuel-pricing.js'
import type { AnalyticsRange, SpeedingQuery, DeliveriesQuery, FuelCostQuery } from './analytics.schema.js'

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

/**
 * Fuel put in, fuel lost, and what both cost — from the FuelFilling/FuelTheft
 * ledger rather than the telemetry channel /fuel-efficiency reads (which this
 * fleet's trackers leave empty).
 *
 * Litres are measured; money is litres × a rate. The rate is the server's
 * configured pump price unless the caller overrides it, and it is echoed in the
 * payload so a client never has to assume one.
 */
export const fuelCost: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FuelCostQuery
    // Same split as `deliveries`: trailing windows serve from the warmed cache,
    // an explicit `to` anchor is an unbounded key space so it computes live.
    const data = q.to
      ? await repo.fuelConsumption(p(req, 'orgId'), q)
      : await getFuelConsumption(p(req, 'orgId'), q.days)
    sendSuccess(res, priceFuelConsumption(data, {
      pricePerLitre: q.pricePerLitre ?? env.FUEL_PRICE_PER_LITRE,
      currency:      env.FUEL_CURRENCY,
      source:        q.pricePerLitre == null ? 'configured' : 'request',
    }))
  } catch (err) { next(err) }
}

/**
 * Today's operational figures — a DIFFERENT window from the rest of this
 * module (local midnight → now, not the trailing month). Litres are priced
 * here rather than in the repository, at the same configured rate `fuelCost`
 * uses, so the two cards on the Analytics page can never quote a different
 * pump price for the same fuel.
 */
export const operationsToday: RequestHandler = async (req, res, next) => {
  try {
    const data = await repo.operationsToday(p(req, 'orgId'))
    const pricePerLitre = env.FUEL_PRICE_PER_LITRE
    sendSuccess(res, {
      ...data,
      fuel: {
        ...data.fuel,
        litresFilled: Math.round(data.fuel.filledMl / 100) / 10,
        cost:         Math.round((data.fuel.filledMl / 1000) * pricePerLitre),
      },
      price: { pricePerLitre, currency: env.FUEL_CURRENCY, source: 'configured' as const },
    })
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
