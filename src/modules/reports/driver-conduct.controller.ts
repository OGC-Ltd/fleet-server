import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './driver-conduct.service.js'
import type { FoundCase, StoredCase, CaseAction, IncidentBody } from './driver-conduct.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string
/** Who is acting: the signed-in user's name, never what the page says. */
const who = (req: Parameters<RequestHandler>[0]) => req.user?.fullName || req.user?.email || 'Unknown user'

/** GET /organisations/:orgId/driver-conduct/cases?from&to — the follow-up cases. */
export const listCases: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.listCases(p(req, 'orgId'), req.query as { from?: string; to?: string }))
  } catch (err) { next(err) }
}

/** GET …/cases/pending-count — the number beside Reports in the sidebar. */
export const pendingCount: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, { pending: await service.pendingCount(p(req, 'orgId')) })
  } catch (err) { next(err) }
}

/** POST …/cases/found — the cases a report run found; answers with every case. */
export const mergeFound: RequestHandler = async (req, res, next) => {
  try {
    const { cases } = req.body as { cases: FoundCase[] }
    sendSuccess(res, await service.mergeFound(p(req, 'orgId'), cases))
  } catch (err) { next(err) }
}

/** PUT …/cases/:caseKey/action — what was done, or null to reopen. */
export const recordAction: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.recordAction(p(req, 'orgId'), p(req, 'caseKey'), req.body as CaseAction, who(req)))
  } catch (err) { next(err) }
}

/** POST …/cases/import — cases a browser kept, or an exported file. */
export const importCases: RequestHandler = async (req, res, next) => {
  try {
    const { cases } = req.body as { cases: StoredCase[] }
    sendSuccess(res, await service.importCases(p(req, 'orgId'), cases))
  } catch (err) { next(err) }
}

export const listIncidents: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.listIncidents(p(req, 'orgId')))
  } catch (err) { next(err) }
}

/** PUT …/incidents/:incidentId — add or change one entry. */
export const saveIncident: RequestHandler = async (req, res, next) => {
  try {
    const body = { ...(req.body as IncidentBody), id: p(req, 'incidentId') }
    sendSuccess(res, await service.saveIncident(p(req, 'orgId'), body, who(req)))
  } catch (err) { next(err) }
}

export const deleteIncident: RequestHandler = async (req, res, next) => {
  try {
    await service.deleteIncident(p(req, 'orgId'), p(req, 'incidentId'))
    sendSuccess(res, { deleted: true })
  } catch (err) { next(err) }
}

export const importIncidents: RequestHandler = async (req, res, next) => {
  try {
    const { entries } = req.body as { entries: IncidentBody[] }
    sendSuccess(res, await service.importIncidents(p(req, 'orgId'), entries))
  } catch (err) { next(err) }
}
