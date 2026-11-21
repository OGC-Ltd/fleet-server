import type { Request, RequestHandler } from 'express'
import { z } from 'zod'
import { sendSuccess } from '../../core/response/response.js'
import { ForbiddenError } from '../../core/errors/errors.js'
import { flaggedOnlyIn } from '../../lib/authz/subject.js'
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
  limit: z.coerce.number().int().min(1).max(1000).optional(),
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
  // A technician sees only the cards of their ControlTech jobs that went on
  // to the workshop: no other card on the unit, no booked-and-released
  // history, no workshop-wide figures (operator, 2026-11-21: "technicians
  // don't need to see what is in the autoworkshop unless it's a unit under
  // their controltech page that was flagged and has progressed into the
  // autoworkshop").
  if (s && req.authz && await flaggedOnlyIn(req.authz.userId, p(req, 'orgId'))) {
    return {
      ...out,
      open: out.open.filter((c) => c.vehicleId && s.has(c.vehicleId) && c.repairItem?.queue === 'controltech'),
      moves: [],
      summary: null,
    }
  }
  return s ? {
    ...out,
    open:  out.open.filter((c) => c.vehicleId && s.has(c.vehicleId)),
    moves: out.moves.filter((m) => m.vehicle && s.has(m.vehicle.id)),
  } : out
})

const cardsFor = async (req: Request) => {
  const vehicleId = p(req, 'vehicleId')
  const s = scope(req)
  if (s && !s.has(vehicleId)) throw new ForbiddenError('This unit is not one of the units assigned to you')
  return cardsOf(p(req, 'orgId'), vehicleId)
}
export const vehicleJobCards = handle(cardsFor)
