import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './fuel.service.js'
import { getProbeReport } from './probe-report.service.js'
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
/**
 * Every probe and sensor on the fleet, with its state, its history and what it
 * is fitted to — see probe-report.service.
 *
 * Whole-fleet and unpaginated, like `tank-state`: the grid draws every unit at
 * once and an operator triaging faults is reading the WHOLE list, not a page of
 * it. Served from a ten-minute cache because the build scans a month of
 * telemetry; probe faults do not move faster than that.
 *
 * `?state=` narrows to what wants attention, which is the view the report is
 * generated from. Anything else returns the fleet.
 */
export const listProbeHealth: RequestHandler = async (req, res, next) => {
  try {
    const rows = await getProbeReport(p(req, 'orgId'))
    const state = String(req.query['state'] ?? '').toLowerCase()
    const filtered = state === 'faulty'  ? rows.filter(r => r.needsAttention)
                   : state === 'healthy' ? rows.filter(r => !r.needsAttention)
                   : rows
    sendSuccess(res, {
      rows: filtered,
      // Counted over the WHOLE fleet, not the filtered set: the tallies are
      // what the operator filters BY, so they must not move when they do.
      summary: {
        total:        rows.length,
        needsAttention: rows.filter(r => r.needsAttention).length,
        probeDied:    rows.filter(r => r.fuelProbe.state === 'DIED').length,
        probeSilent:  rows.filter(r => r.fuelProbe.state === 'SILENT').length,
        probeOk:      rows.filter(r => r.fuelProbe.state === 'OK').length,
        sensorUncalibrated: rows.filter(r => r.fuelSensor.uncalibrated).length,
        // Provisioned and saying nothing. Counted separately because it is not
        // a probe fault — no channel on the unit can be judged at all.
        trackerSilent:      rows.filter(r => r.trackerSilent).length,
      },
      generatedAt: new Date().toISOString(),
    })
  } catch (err) { next(err) }
}

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
 *
 * ## The last instant of the day, NOT the first of the next
 *
 * This is a one-millisecond distinction that silently emptied every past day,
 * and it is worth stating why rather than leaving the `- 1` looking like a
 * rounding nicety.
 *
 * `getFleetTankState` derives its own day from the `asOf` it is handed —
 * `fleetDayStart(asOf)` — so `asOf` must land INSIDE the day being asked for.
 * Midnight-at-the-end belongs to the following day: `fleetDayStart` of it
 * returns that same instant, the service's window becomes
 * `[asOf, asOf]`, and every figure derived from the day's readings — closing
 * level, mileage, engine hours, both expected burns, turbulence, stops — comes
 * back null for want of any rows in a zero-width window.
 *
 * It fails in a way designed to be missed: the previous-day lookup, which
 * reaches back 24 hours from that same boundary, then spans exactly the day
 * that was requested, so the table renders the requested day's real closing
 * level in the INITIAL column while Current sits blank. It reads as a data gap
 * rather than an off-by-one.
 *
 * `recordFuelTrends` has always bounded its own day this way, which is why the
 * persisted `fuel_daily_trends` rows are right where the live table was wrong.
 */
export function asOfFromQuery(raw: unknown): Date {
  const now = new Date()
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return now
  const dayStart = fleetDayStart(new Date(`${raw}T12:00:00Z`))
  if (Number.isNaN(dayStart.getTime())) return now
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1)
  return dayEnd < now ? dayEnd : now
}
