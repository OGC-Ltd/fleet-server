/**
 * A Fuel Report's data in one request (2026-10-10: "300+ users generating
 * reports"): every fleet day's readings across the period, and the period's
 * drains and fillings.
 *
 *   GET /organisations/:orgId/fuel/report-data/vehicles/:vehicleId?from&to
 *
 * The page used to make three requests a day — the day's readings, its drains,
 * its fillings — so a month was 90 requests, nine at a time, each a query on
 * the live pool. Now:
 *
 *   · a finished day comes from the shared day cache (telemetry
 *     day-series-cache), read from the database once for everyone;
 *   · a day not yet held is read on the REPORT pool (lib/report-db), a few at a
 *     time, so a wave of reports queues behind itself and never behind, or in
 *     front of, telemetry ingest;
 *   · drains and fillings are one query each for the whole period.
 *
 * Each day goes out exactly as the day route sends it (getVehicleDaySeries), so
 * the page decodes it the same way. The body is assembled from the days' JSON
 * as kept, rather than parsed and serialised again on every request.
 */

import type { RequestHandler } from 'express'
import { z } from 'zod'
import { reportDb } from '../../lib/report-db.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { getVehicleDaySeries } from '../telemetry/telemetry.service.js'
import { vehicleExistsInOrg } from '../telemetry/telemetry.repository.js'
import { cachedDay, keepDay, settled } from '../telemetry/day-series-cache.js'
import { fillDayVoltages } from '../telemetry/day-voltage-fill.js'
import { wialonUnitId } from './fuel-sync.service.js'
import { findAllFillings, findAllThefts } from './fuel.repository.js'
import type { ListFillingQuery, ListTheftQuery } from './fuel.schema.js'

const DAY_MS = 86_400_000
/** As the Logbook's limit: about a quarter. */
export const MAX_REPORT_DAYS = 92
/** Days one report reads from the database at once. */
const DAYS_AT_ONCE = 3
/** More events than any unit's quarter has held. */
const EVENTS_LIMIT = 5_000

export const reportDataQuery = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
})
  .refine(q => q.to > q.from, { message: 'to must be after from' })
  .refine(q => q.to - q.from <= MAX_REPORT_DAYS * DAY_MS, { message: `One report covers at most ${MAX_REPORT_DAYS} days` })

/** The fleet (EAT) days the period touches, first to last. */
export function reportDays(from: number, to: number, now = Date.now()): string[] {
  const key = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10)
  const out: string[] = []
  const last = key(Math.min(to, now) - 1)
  for (let d = key(from); d <= last; d = key(fleetDayBounds(d)!.to.getTime())) out.push(d)
  return out
}

/**
 * One day's JSON: kept when finished, read on the report pool when not. A day
 * whose readings carry no supply voltage has them filled from the unit's
 * Wialon messages (telemetry/day-voltage-fill) before it is kept.
 */
async function dayJson(vehicleId: string, orgId: string, day: string, wialonUnit: number | null): Promise<string> {
  const finished = settled(fleetDayBounds(day)!.to.getTime())
  if (finished) {
    const kept = await cachedDay(vehicleId, day)
    if (kept) return kept
  }
  const data = await getVehicleDaySeries(vehicleId, orgId, { day } as Parameters<typeof getVehicleDaySeries>[2], reportDb())
  await fillDayVoltages(data, `${vehicleId}|${day}`, wialonUnit)
  const json = JSON.stringify(data)
  // A truncated day is not kept: the next read might not be.
  if (finished && data.complete && !data.truncated) await keepDay(vehicleId, day, json)
  return json
}

/** Runs `fn` over `items`, `n` at a time; each result or the error it threw. */
async function limited<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<({ ok: true; v: R } | { ok: false })[]> {
  const out: ({ ok: true; v: R } | { ok: false })[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      try { out[i] = { ok: true, v: await fn(items[i]!) } } catch { out[i] = { ok: false } }
    }
  }))
  return out
}

/** The response body, put together from the days' JSON as kept. */
export function reportBody(o: { vehicleId: string; from: number; to: number; days: string[]; failedDays: number; drains: unknown[]; fillings: unknown[] }): string {
  return `{"statusCode":200,"status":"success","data":{"vehicleId":${JSON.stringify(o.vehicleId)},"from":${o.from},"to":${o.to},`
    + `"failedDays":${o.failedDays},"days":[${o.days.join(',')}],`
    + `"drains":${JSON.stringify(o.drains)},"fillings":${JSON.stringify(o.fillings)}}}`
}

export const getFuelReportData: RequestHandler = async (req, res, next) => {
  try {
    const orgId = req.params['orgId'] as string
    const vehicleId = req.params['vehicleId'] as string
    const { from, to } = req.query as unknown as z.infer<typeof reportDataQuery>
    const db = reportDb()
    // Once here: a day served from the cache does not ask again.
    if (!(await vehicleExistsInOrg(vehicleId, orgId, db))) throw new NotFoundError('Vehicle not found')
    const unit = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { deviceId: true } })
    const wialonUnit = wialonUnitId(unit?.deviceId)

    const range = { vehicleId, from: new Date(from), to: new Date(to), limit: EVENTS_LIMIT }
    const [days, drains, fillings] = await Promise.all([
      limited(reportDays(from, to), DAYS_AT_ONCE, day => dayJson(vehicleId, orgId, day, wialonUnit)),
      findAllThefts(orgId, range as ListTheftQuery, db),
      findAllFillings(orgId, range as ListFillingQuery, db),
    ])
    const ok = days.filter((d): d is { ok: true; v: string } => d.ok).map(d => d.v)
    res.setHeader('Cache-Control', 'no-store')
    res.type('application/json').send(reportBody({
      vehicleId, from, to, days: ok, failedDays: days.length - ok.length, drains: drains.data, fillings: fillings.data,
    }))
  } catch (err) { next(err) }
}
