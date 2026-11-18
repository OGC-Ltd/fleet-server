import type { Request, RequestHandler } from 'express'
import { z } from 'zod'
import { sendSuccess } from '../../core/response/response.js'
import { ForbiddenError } from '../../core/errors/errors.js'
import { searchParts, vehicleJobCards as cardsOf, workshopBoard } from './factorysuite-workshop.sync.js'

const p = (req: Request, key: string) => req.params[key] as string
const scope = (req: Request) => req.authz?.vehicleIds ?? null

const handle = (fn: (req: Request) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try { sendSuccess(res, await fn(req)) } catch (err) { next(err) }
  }

const partsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  low: z.enum(['1', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
const boardQuery = z.object({ days: z.coerce.number().int().min(1).max(90).optional() })

export const parts = handle((req) => {
  const q = partsQuery.parse(req.query)
  return searchParts(p(req, 'orgId'), q.q, { lowOnly: !!q.low, ...(q.limit ? { limit: q.limit } : {}) })
})

export const board = handle(async (req) => {
  const q = boardQuery.parse(req.query)
  const out = await workshopBoard(p(req, 'orgId'), q.days ?? 7)
  const s = scope(req)
  return s ? { ...out, open: out.open.filter((c) => c.vehicleId && s.has(c.vehicleId)) } : out
})

const cardsFor = async (req: Request) => {
  const vehicleId = p(req, 'vehicleId')
  const s = scope(req)
  if (s && !s.has(vehicleId)) throw new ForbiddenError('This unit is not one of the units assigned to you')
  return cardsOf(p(req, 'orgId'), vehicleId)
}
export const vehicleJobCards = handle(cardsFor)
