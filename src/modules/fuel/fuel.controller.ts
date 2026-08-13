import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './fuel.service.js'
import { getFleetTankState } from './fuel-tank-state.service.js'
import { fleetDayStart } from '../../lib/provider-time.js'
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

/**
 * Per-vehicle tank state for the Fuel FSL table: what the tank held when the
 * machine started work, what it holds now, and how much the probe moved about
 * while working. See modules/fuel/fuel-tank-state.
 *
 * Whole-fleet in one call on purpose — the table draws every vehicle, and a
 * per-vehicle endpoint would have the dashboard fire 200 requests against a
 * 100 req/60s limit.
 */
export const listTankState: RequestHandler = async (req, res, next) => {
  try {
    // `?date=YYYY-MM-DD` reads the tank as it stood at the END of that fleet
    // day, so the FSL table's Initial/Current pair matches the events it is
    // shown beside. Omitted, or today, means now — a day still in progress has
    // no end, and pinning it to midnight would freeze the live column.
    const asOf = asOfFromQuery(req.query['date'])
    sendSuccess(res, await getFleetTankState(p(req, 'orgId'), asOf))
  } catch (err) { next(err) }
}

/**
 * End of the requested fleet day, or now — whichever is earlier.
 *
 * Fleet days are Kenyan, not UTC (see lib/provider-time): a 01:00 EAT reading
 * belongs to that day and not the previous one. An unparseable or future date
 * falls back to now rather than erroring, because this drives a table and a bad
 * query string should not blank it.
 */
function asOfFromQuery(raw: unknown): Date {
  const now = new Date()
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return now
  const dayStart = fleetDayStart(new Date(`${raw}T12:00:00Z`))
  if (Number.isNaN(dayStart.getTime())) return now
  const dayEnd = new Date(dayStart.getTime() + 86_400_000)
  return dayEnd < now ? dayEnd : now
}
