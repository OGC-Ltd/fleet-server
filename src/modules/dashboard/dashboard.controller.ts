import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { prisma } from '../../lib/prisma.js'
import { getDashboardSummary } from './dashboard.service.js'
import { getRouteWeather } from './dashboard.weather.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const getSummary: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getDashboardSummary(p(req, 'orgId')))
  } catch (err) { next(err) }
}

// orgId → org code, cached — weather location sets are keyed by code.
const orgCodeCache = new Map<string, string>()

export const getWeather: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')
    let code = orgCodeCache.get(orgId)
    if (!code) {
      const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { code: true } })
      code = org?.code ?? 'SUKARI'
      orgCodeCache.set(orgId, code)
    }
    sendSuccess(res, await getRouteWeather(code))
  } catch (err) { next(err) }
}
