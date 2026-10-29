import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { getTripReportData } from './trip-report.service.js'

/** ?dispatch=<externalId> picks the run; without it, the vehicle's latest. */
export const getTripReportHandler: RequestHandler = async (req, res, next) => {
  try {
    const dispatch = typeof req.query.dispatch === 'string' && req.query.dispatch.trim() ? req.query.dispatch.trim() : undefined
    sendSuccess(res, await getTripReportData(req.params.orgId as string, req.params.vehicleId as string, dispatch))
  } catch (err) { next(err) }
}
