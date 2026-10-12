import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import * as service from './alerts.service.js'
import type { ListAlertsQuery, ReviewSpeedingDto } from './alerts.schema.js'

const userOf = (req: Parameters<RequestHandler>[0]): string => {
  const id = req.user?.id
  if (!id) throw new UnauthorizedError('An account is required')
  return id
}

/** GET /api/v1/alerts — every organisation the caller may read, filtered. */
export const list: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.listAlerts(userOf(req), req.query as unknown as ListAlertsQuery))
  } catch (err) { next(err) }
}

/** POST /organisations/:orgId/incidents/speeding/:incidentId/review */
export const reviewSpeeding: RequestHandler = async (req, res, next) => {
  try {
    const { outcome, note } = req.body as ReviewSpeedingDto
    sendSuccess(res, await service.reviewSpeeding(
      req.params['orgId'] as string, req.params['incidentId'] as string, userOf(req), outcome, note,
    ))
  } catch (err) { next(err) }
}
