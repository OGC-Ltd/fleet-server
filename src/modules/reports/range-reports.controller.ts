import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './range-reports.service.js'
import { unitDistance as unitDistanceOf } from './unit-distance.service.js'
import { odometerAt as odometerAtOf, type OdoPoint } from './odometer-at.service.js'

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

/** POST …/reports/unit-distance { day, vehicleIds } — each unit's day by odometer, pulled from Wialon and stored where missing. */
export const unitDistance: RequestHandler = async (req, res, next) => {
  try {
    const { day, vehicleIds } = req.body as { day: string; vehicleIds: string[] }
    sendSuccess(res, await unitDistanceOf(p(req, 'orgId'), req.authz?.vehicleIds ?? null, day, vehicleIds))
  } catch (err) { next(err) }
}

/** POST …/reports/odometer-at { points: [{ vehicleId, at }] } — each unit's odometer at each moment, filled from Wialon where missing. */
export const odometerAt: RequestHandler = async (req, res, next) => {
  try {
    const { points } = req.body as { points: OdoPoint[] }
    sendSuccess(res, await odometerAtOf(p(req, 'orgId'), req.authz?.vehicleIds ?? null, points))
  } catch (err) { next(err) }
}
