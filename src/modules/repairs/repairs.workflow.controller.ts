import type { Request, RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as wf from './repairs.workflow.js'
import * as overhaul from './repairs.overhaul.js'
import type {
  Assessment, Booking, Complete, Damage, FlagUnits, InvestigationUpdate, IssuePart, PathBody,
  SourcePart, SpotFix, Verify, VoidBody, WarrantyVoid, WorkEntry, WorkshopAssign, MovePhase,
} from './repairs.workflow.schema.js'

const p = (req: Request, key: string) => req.params[key] as string
/** The caller's vehicle scope: null = the whole fleet (and always null in shadow mode). */
const scope = (req: Request) => req.authz?.vehicleIds ?? null

/** One handler shape for every route here: run, answer, pass errors on. */
const handle = (fn: (req: Request) => Promise<unknown>, status = 200): RequestHandler =>
  async (req, res, next) => {
    try { sendSuccess(res, await fn(req), status) } catch (err) { next(err) }
  }

export const flagUnits = handle((req) => wf.flagUnits(p(req, 'orgId'), req.user!.id, req.body as FlagUnits, scope(req)), 201)
export const spotFix = handle((req) => wf.spotFix(p(req, 'orgId'), req.user!.id, req.body as SpotFix, scope(req)), 201)
export const forward = handle((req) => wf.forwardJob(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, (req.body as { queue?: 'controltech' | 'workshop' }).queue))
export const queue = handle((req) => wf.queue(p(req, 'orgId')))
export const claim = handle((req) => wf.claim(p(req, 'orgId'), p(req, 'itemId'), req.user!.id))
export const path = handle((req) => wf.decidePath(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as PathBody))
export const assess = handle((req) => wf.assess(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as Assessment, scope(req)))

export const workshops = handle((req) => wf.workshops(p(req, 'orgId')))
export const updateWorkshop = handle((req) => wf.updateWorkshop(p(req, 'orgId'), p(req, 'workshopId'), req.body))
export const availability = handle((req) => wf.availability(p(req, 'orgId'), p(req, 'workshopId'), Number((req.query as { days?: number }).days ?? 14)))
export const workshopDay = handle((req) => wf.workshopDay(p(req, 'orgId'), p(req, 'workshopId'), String((req.query as { date: string }).date)))
export const book = handle((req) => wf.book(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as Booking, scope(req)))
export const cancelBooking = handle((req) => wf.cancelBooking(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, (req.body as { reason: string }).reason, scope(req)))
export const arrive = handle((req) => wf.arrive(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, scope(req)))
export const workshopAssign = handle((req) => wf.workshopAssign(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as WorkshopAssign))

export const damage = handle((req) => wf.classifyDamage(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as Damage))
export const voidWarranty = handle((req) => wf.voidWarranty(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as WarrantyVoid))
export const clearWarranty = handle((req) => wf.clearWarranty(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, (req.body as { note: string }).note))

export const work = handle((req) => wf.addWork(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as WorkEntry, scope(req)), 201)
export const complete = handle((req) => wf.complete(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as Complete))
export const verify = handle((req) => wf.verify(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as Verify, scope(req)))
export const movePhase = handle((req) => wf.movePhase(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as MovePhase))
export const voidJob = handle((req) => wf.voidJob(p(req, 'orgId'), p(req, 'itemId'), req.user!.id, req.body as VoidBody))
export const ticket = handle((req) => wf.ticket(p(req, 'orgId'), p(req, 'itemId')))
export const serviceStates = handle((req) => wf.serviceStates(p(req, 'orgId'), scope(req)))

export const sourcePart = handle((req) => overhaul.sourcePart(p(req, 'orgId'), p(req, 'itemId'), p(req, 'partId'), req.user!.id, req.body as SourcePart))
export const issuePart = handle((req) => overhaul.issuePart(p(req, 'orgId'), p(req, 'itemId'), p(req, 'partId'), req.user!.id, req.body as IssuePart))

export const investigations = handle((req) => wf.investigations(p(req, 'orgId'), (req.query as { status?: 'open' | 'closed' | 'all' }).status))
export const securityHolders = handle((req) => wf.securityHolders(p(req, 'orgId')))
export const updateInvestigation = handle((req) => wf.updateInvestigation(p(req, 'orgId'), p(req, 'investigationId'), req.user!.id, req.body as InvestigationUpdate))
export const flaggableUnits = handle((req) => wf.flaggableUnits(p(req, 'orgId'), scope(req)))
