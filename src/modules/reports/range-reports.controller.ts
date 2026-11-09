import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './range-reports.service.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string
const range = (req: Parameters<RequestHandler>[0]) => req.query as { from: string; to: string }

/** GET /organisations/:orgId/reports/fuel-consumption-rate?from&to — per unit, fleet days. */
export const fuelConsumptionRate: RequestHandler = async (req, res, next) => {
  try {
    const { from, to } = range(req)
    sendSuccess(res, await service.fuelConsumptionRate(p(req, 'orgId'), req.authz?.vehicleIds ?? null, from, to))
  } catch (err) { next(err) }
}

/** GET …/reports/alarm-distribution?from&to — dashcam alarms per unit by kind. */
export const alarmDistribution: RequestHandler = async (req, res, next) => {
  try {
    const { from, to } = range(req)
    sendSuccess(res, await service.alarmDistribution(p(req, 'orgId'), req.authz?.vehicleIds ?? null, from, to))
  } catch (err) { next(err) }
}

/** GET …/reports/unauthorized-passengers?from&to — the logged incidents. */
export const unauthorizedPassengers: RequestHandler = async (req, res, next) => {
  try {
    const { from, to } = range(req)
    sendSuccess(res, await service.unauthorizedPassengers(p(req, 'orgId'), req.authz?.vehicleIds ?? null, from, to))
  } catch (err) { next(err) }
}
