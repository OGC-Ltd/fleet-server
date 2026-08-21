import type { RequestHandler } from 'express'
import { earlyStartsByCategory, operatingHoursByCategory, fleetWeekSummary } from './machine-operations.service.js'
import { getFleetState } from './fleet-state.service.js'
import { getExcavatorArea, getAreaByDay } from './excavator-area.service.js'
import { getFuelRateSeries } from './fuel-rate-series.service.js'
import { sendSuccess } from '../../core/response/response.js'
import { env } from '../../config/env.js'
import * as repo from './analytics.repository.js'
import { getDriversOverview, DEFAULT_DRIVER_WINDOW_DAYS } from './drivers-overview.cache.js'
import { getDeliveriesAnalytics } from './deliveries.cache.js'
import { getFuelConsumption } from './fuel-cost.cache.js'
import { priceFuelConsumption } from './fuel-pricing.js'
import type { AnalyticsRange, SpeedingQuery, DeliveriesQuery, FuelCostQuery } from './analytics.schema.js'
import { vehicleIdsFromQuery, listCategories } from './vehicle-filter.js'

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
    const vehicleIds = await vehicleIdsFromQuery(p(req, 'orgId'), q.categories)
    // Trailing windows serve from the warmed cache; an explicit `to` anchor
    // or a vehicle-type filter is an unbounded key space, so it computes live
    // like before.
    const data = q.to || vehicleIds != null
      ? await repo.deliveriesAnalytics(p(req, 'orgId'), q, vehicleIds)
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
    const vehicleIds = await vehicleIdsFromQuery(p(req, 'orgId'), q.categories)
    // Same split as `deliveries`: trailing windows serve from the warmed cache,
    // an anchor or a vehicle filter is an unbounded key space so it computes live.
    const data = q.to || vehicleIds != null
      ? await repo.fuelConsumption(p(req, 'orgId'), q, vehicleIds)
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
/**
 * When machines started work today, by category — see machine-operations.
 *
 * Separate from operationsToday's `earlyDepartures`, which counts tractor
 * SIGN-OUTS. That is the right clock for a fleet whose units mostly have no
 * tracker; it is the wrong one for plant, which is never signed out. An
 * excavator is switched on in a pit and works without going anywhere.
 */
export const machineStarts: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await earlyStartsByCategory(p(req, 'orgId')))
  } catch (err) { next(err) }
}

/**
 * Hours actually run against the 18-hour day, by category, over a day, a week
 * or a month. An unrecognised range falls back to `day` rather than erroring —
 * this drives a chart, and a bad query string should not blank it.
 */
export const machineHours: RequestHandler = async (req, res, next) => {
  try {
    const asked = String(req.query['range'] ?? 'day')
    const range = asked === 'week' || asked === 'month' ? asked : 'day'
    sendSuccess(res, await operatingHoursByCategory(p(req, 'orgId'), range))
  } catch (err) { next(err) }
}

/** The week for the summary card. Carries blocks worked rather than area
 *  cleared, which nothing on this fleet can measure — see the service. */
export const machineSummary: RequestHandler = async (req, res, next) => {
  try {
    const days = Number(req.query['days']) || 7
    // `to` anchors the window on a past month or a custom range. Without it
    // this endpoint always answered for the trailing N days ending today, so
    // the Analytics summary card was the one component the page's date picker
    // could not move.
    const toRaw = String(req.query['to'] ?? '')
    const to = toRaw ? new Date(toRaw) : undefined
    const vehicleIds = await vehicleIdsFromQuery(p(req, 'orgId'), req.query['categories'])
    sendSuccess(res, await fleetWeekSummary(p(req, 'orgId'), days,
      to && !Number.isNaN(to.getTime()) ? to : undefined, vehicleIds))
  } catch (err) { next(err) }
}

/** Every unit's live state plus its hours, idle time and distance for today,
 *  the week and the month — see fleet-state.service. */
export const fleetStateHandler: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getFleetState(p(req, 'orgId')))
  } catch (err) { next(err) }
}

/** Ground each excavator worked over, and the hours it spent — see
 *  excavator-area.service. Defaults to the last COMPLETE fleet day. */
export const excavatorArea: RequestHandler = async (req, res, next) => {
  try {
    const asked = String(req.query['day'] ?? '')
    const day = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? new Date(`${asked}T00:00:00Z`) : undefined
    const vehicleIds = await vehicleIdsFromQuery(p(req, 'orgId'), req.query['categories'])
    sendSuccess(res, await getExcavatorArea(p(req, 'orgId'), day, vehicleIds))
  } catch (err) { next(err) }
}

/** Ground worked per fleet day, for the plant daily-activity heatmap. Read
 *  from the rollup — see areaByDay. */
export const excavatorAreaByDay: RequestHandler = async (req, res, next) => {
  try {
    const asked = Number(req.query['days'])
    const days = Number.isFinite(asked) ? Math.min(90, Math.max(1, Math.trunc(asked))) : 30
    const toRaw = String(req.query['to'] ?? '')
    const to = toRaw ? new Date(toRaw) : undefined
    const vehicleIds = await vehicleIdsFromQuery(p(req, 'orgId'), req.query['categories'])
    sendSuccess(res, await getAreaByDay(p(req, 'orgId'), days,
      to && !Number.isNaN(to.getTime()) ? to : undefined, vehicleIds))
  } catch (err) { next(err) }
}

/** Litres per hectare and per kilometre, day by day — see fuel-rate-series. */
export const fuelRateDays: RequestHandler = async (req, res, next) => {
  try {
    const asked = Number(req.query['days'])
    const days = Number.isFinite(asked) ? Math.min(90, Math.max(1, Math.trunc(asked))) : 30
    const toRaw = String(req.query['to'] ?? '')
    const to = toRaw ? new Date(toRaw) : undefined
    const vehicleIds = await vehicleIdsFromQuery(p(req, 'orgId'), req.query['categories'])
    sendSuccess(res, await getFuelRateSeries(p(req, 'orgId'), days,
      to && !Number.isNaN(to.getTime()) ? to : undefined, vehicleIds))
  } catch (err) { next(err) }
}

export const operationsToday: RequestHandler = async (req, res, next) => {
  try {
    const vehicleIds = await vehicleIdsFromQuery(p(req, 'orgId'), req.query['categories'])
    const data = await repo.operationsToday(p(req, 'orgId'), vehicleIds)
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


/**
 * What vehicle categories this fleet HAS, for the Analytics filter control.
 *
 * Derived from the fleet's own plates rather than served from a list, because
 * the vocabulary is per-fleet: KASULU's plates carry a machine family (EX, CTR,
 * DZ) and SUKARI's are ordinary registrations that carry none. A fleet that
 * comes back with a single category is telling the client to render no filter
 * at all — see vehicle-filter for why that is the honest answer rather than a
 * control with one meaningless option in it.
 */
export const vehicleCategories: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, { categories: await listCategories(p(req, 'orgId')) })
  } catch (err) { next(err) }
}
