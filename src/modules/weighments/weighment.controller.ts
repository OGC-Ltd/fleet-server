import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { getWeighmentDay } from './weighment.service.js'
import { getWeighmentAnalytics } from './weighment.analytics.js'
import { getWeighbridges } from './weighbridge.service.js'
import type { WeighmentQuery, WeighmentAnalyticsQuery } from './weighment.schema.js'

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

/**
 * The same scales over a WINDOW of days rather than on one date.
 *
 * A separate route from `listDay` and not a mode of it, because the two return
 * different things for different readers: that one is a grid of tickets with
 * the day's stats attached, this one is four measures per day with no ticket
 * in it at all. Folding them together would give one endpoint whose response
 * shape depends on whether a query parameter was present.
 *
 * The whole result is the payload, as above — the per-centre breakdown and the
 * captured span describe the window, not a page of it.
 */
export const listAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const out = await getWeighmentAnalytics(
      p(req, 'orgId'), req.query as unknown as WeighmentAnalyticsQuery,
    )
    sendSuccess(res, out)
  } catch (err) { next(err) }
}

/**
 * The scales themselves, each with the last weighing it took.
 *
 * Not a slice of the day endpoint above: that one answers "what happened on
 * this date", and this one answers "where are the bridges and what is the
 * latest at each", which has no day in it at all. A marker on a map must not
 * go blank because the operator is looking at a quiet Sunday.
 */
export const listBridges: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getWeighbridges(p(req, 'orgId')))
  } catch (err) { next(err) }
}
