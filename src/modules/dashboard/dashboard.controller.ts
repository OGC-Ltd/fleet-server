import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { getDashboardSummary } from './dashboard.service.js'
import { getRouteWeather } from './dashboard.weather.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const getSummary: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getDashboardSummary(p(req, 'orgId')))
  } catch (err) { next(err) }
}

export const getWeather: RequestHandler = async (_req, res, next) => {
  try {
    sendSuccess(res, await getRouteWeather())
  } catch (err) { next(err) }
}
