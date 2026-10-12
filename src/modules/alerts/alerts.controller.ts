import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import * as service from './alerts.service.js'
import type { ListAlertsQuery, MarkReadDto, ReviewSpeedingDto } from './alerts.schema.js'

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

/** GET /api/v1/alerts/summary — the badge: open alerts over the page's default week. */
export const summary: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.alertSummary(userOf(req)))
  } catch (err) { next(err) }
}

/** GET /api/v1/alerts/history — every alert ever received, a day at a time. */
export const history: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.alertHistory(userOf(req)))
  } catch (err) { next(err) }
}

/** POST /api/v1/alerts/read — mark alerts read, for the caller only. */
export const markRead: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.markRead(userOf(req), (req.body as MarkReadDto).items))
  } catch (err) { next(err) }
}

/** POST /api/v1/alerts/read-all — every alert so far is read, for the caller only. */
export const markAllRead: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.markAllRead(userOf(req)))
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
