import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { getWeighmentDay } from './weighment.service.js'
import type { WeighmentQuery } from './weighment.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

/**
 * One fleet day of weighbridge tickets, plus the day's stats and the tab
 * counts.
 *
 * The whole result is the payload rather than a page: the stats and the centre
 * counts describe the day, not the rows returned, so putting the rows in
 * `data` and the rest in the pagination `meta` slot would say something false
 * about both.
 */
export const listDay: RequestHandler = async (req, res, next) => {
  try {
    const day = await getWeighmentDay(p(req, 'orgId'), req.query as unknown as WeighmentQuery)
    sendSuccess(res, day)
  } catch (err) { next(err) }
}
