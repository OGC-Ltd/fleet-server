import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './report.service.js'
import type { CreatePeriodDto, CreateEngineSessionDto, ListPeriodQuery, ListEngineSessionQuery, ListSummaryQuery } from './report.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

// ── Periods ───────────────────────────────────────────────────────────────────

export const listPeriods: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listPeriods(p(req, 'orgId'), req.query as unknown as ListPeriodQuery)
    sendSuccess(res, data, 200, { total })
  } catch (err) { next(err) }
}

export const getPeriod: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getPeriod(p(req, 'orgId'), p(req, 'periodId')))
  } catch (err) { next(err) }
}

export const createPeriod: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createPeriod(p(req, 'orgId'), req.body as CreatePeriodDto), 201)
  } catch (err) { next(err) }
}

// ── Engine Sessions ───────────────────────────────────────────────────────────

export const listEngineSessions: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.listEngineSessions(p(req, 'orgId'), req.query as unknown as ListEngineSessionQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const createEngineSession: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createEngineSession(req.body as CreateEngineSessionDto), 201)
  } catch (err) { next(err) }
}

// ── Summaries ─────────────────────────────────────────────────────────────────

export const listSummaries: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listSummaries(p(req, 'orgId'), req.query as unknown as ListSummaryQuery)
    sendSuccess(res, data, 200, { total })
  } catch (err) { next(err) }
}

export const refreshSummaries: RequestHandler = async (req, res, next) => {
  try {
    const result = await service.refreshSummaries(p(req, 'orgId'), p(req, 'periodId'))
    sendSuccess(res, result)
  } catch (err) { next(err) }
}
