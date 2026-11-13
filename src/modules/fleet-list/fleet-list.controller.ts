import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as svc from './fleet-list.service.js'
import type { SaveFleetList } from './fleet-list.schema.js'

const org = (req: Parameters<RequestHandler>[0]) => req.params.orgId as string
const actor = (req: Parameters<RequestHandler>[0]): svc.Actor => ({
  id: req.user?.id ?? null,
  name: req.user?.fullName || req.user?.email || null,
})

/** GET /organisations/:orgId/fleet-list */
export const get: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.current(org(req))) } catch (err) { next(err) }
}

/** POST /organisations/:orgId/fleet-list */
export const save: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.save(org(req), actor(req), req.body as SaveFleetList), 201) } catch (err) { next(err) }
}

/** GET /organisations/:orgId/fleet-list/:id/file: { fileName, url, expiresIn } */
export const file: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.fileLink(org(req), req.params.id as string)) } catch (err) { next(err) }
}

/** POST /organisations/:orgId/fleet-list/reset */
export const reset: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, await svc.reset(org(req), actor(req))) } catch (err) { next(err) }
}
