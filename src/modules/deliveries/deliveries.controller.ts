import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as svc from './deliveries.service.js'
import type { DaySave, OrderSave } from './deliveries.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const getDay: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.getDay(p(req, 'orgId'), p(req, 'day'))) } catch (err) { next(err) }
}

export const saveDay: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.saveDay(p(req, 'orgId'), p(req, 'day'), req.user?.id ?? null, req.body as DaySave)) } catch (err) { next(err) }
}

export const lastDayBefore: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.lastDayBefore(p(req, 'orgId'), (req.query as { before: string }).before)) } catch (err) { next(err) }
}

export const getOrders: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.getOrders(p(req, 'orgId'))) } catch (err) { next(err) }
}

export const saveOrder: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.saveOrder(p(req, 'orgId'), p(req, 'plate'), (req.body as OrderSave).text, req.user?.id ?? null))
  } catch (err) { next(err) }
}
