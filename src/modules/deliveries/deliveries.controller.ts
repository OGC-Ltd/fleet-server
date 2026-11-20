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

/** What each save of the day replaced, the latest first: a day emptied by mistake is put back from here. */
export const getDayVersions: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.dayVersions(p(req, 'orgId'), p(req, 'day'))) } catch (err) { next(err) }
}

/** ?before=day: the latest earlier day with a list. ?from=&to=: every day of the range, in order. */
export const listDays: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as { before?: string; from?: string; to?: string }
    sendSuccess(res, q.before != null
      ? await svc.lastDayBefore(p(req, 'orgId'), q.before)
      : await svc.getDays(p(req, 'orgId'), q.from as string, q.to as string))
  } catch (err) { next(err) }
}

export const getOrders: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.getOrders(p(req, 'orgId'))) } catch (err) { next(err) }
}

export const saveOrder: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.saveOrder(p(req, 'orgId'), p(req, 'plate'), (req.body as OrderSave).text, req.user?.id ?? null))
  } catch (err) { next(err) }
}
