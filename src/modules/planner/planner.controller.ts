import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as svc from './planner.service.js'
import type { PreviewSheet, SaveSheet, PlanListQuery, StopUpdate } from './planner.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const preview: RequestHandler = async (req, res, next) => {
  try {
    const b = req.body as PreviewSheet
    sendSuccess(res, await svc.previewSheet(p(req, 'orgId'), b.fileName, b.data))
  } catch (err) { next(err) }
}

export const save: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.saveSheet(p(req, 'orgId'), req.user?.id ?? null, req.body as SaveSheet), 201)
  } catch (err) { next(err) }
}

export const list: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.listPlans(p(req, 'orgId'), req.query as unknown as PlanListQuery))
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.getPlan(p(req, 'orgId'), p(req, 'planId')))
  } catch (err) { next(err) }
}

export const updateStop: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.updateStop(p(req, 'orgId'), p(req, 'planId'), p(req, 'stopId'), req.user?.id ?? null, req.body as StopUpdate))
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await svc.removePlan(p(req, 'orgId'), p(req, 'planId'))
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

export const customers: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.listCustomers(p(req, 'orgId'), (req.query as { q?: string }).q))
  } catch (err) { next(err) }
}
