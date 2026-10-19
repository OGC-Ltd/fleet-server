import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './vehicle.service.js'
import { getVehicleBrief } from './vehicle-brief.js'
import { getVehicleInsight } from './vehicle-insight.js'
import type { CreateGroupDto, UpdateGroupDto, CreateVehicleDto, UpdateVehicleDto, CreateAssignmentDto, ListQuery } from './vehicle.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

// ── Groups ──────────────────────────────────────────────────────────────────

export const listGroups: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listGroups(p(req, 'orgId'), Number(req.query['page'] ?? 1), Number(req.query['limit'] ?? 20))
    sendSuccess(res, data, 200, { total })
  } catch (err) { next(err) }
}

export const createGroup: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createGroup(p(req, 'orgId'), req.body as CreateGroupDto), 201)
  } catch (err) { next(err) }
}

export const updateGroup: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.updateGroup(p(req, 'orgId'), p(req, 'groupId'), req.body as UpdateGroupDto))
  } catch (err) { next(err) }
}

// ── Vehicles ─────────────────────────────────────────────────────────────────

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listVehicles(p(req, 'orgId'), req.query as unknown as ListQuery, req.authz?.vehicleIds ?? null)
    sendSuccess(res, data, 200, { total, page: Number(req.query['page']), limit: Number(req.query['limit']) })
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getVehicle(p(req, 'orgId'), p(req, 'vehicleId')))
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createVehicle(p(req, 'orgId'), req.body as CreateVehicleDto), 201)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.updateVehicle(p(req, 'orgId'), p(req, 'vehicleId'), req.body as UpdateVehicleDto))
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await service.deleteVehicle(p(req, 'orgId'), p(req, 'vehicleId'))
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

// ── Assignments ──────────────────────────────────────────────────────────────

export const listAssignments: RequestHandler = async (req, res, next) => {
  try {
    const activeOnly = req.query['active'] === 'true'
    const data = await service.listAssignments(p(req, 'orgId'), p(req, 'vehicleId'), activeOnly)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const createAssignment: RequestHandler = async (req, res, next) => {
  try {
    const result = await service.createAssignment(p(req, 'orgId'), p(req, 'vehicleId'), req.body as CreateAssignmentDto, req.user?.id)
    sendSuccess(res, result, 201)
  } catch (err) { next(err) }
}

export const endAssignment: RequestHandler = async (req, res, next) => {
  try {
    const result = await service.endAssignment(p(req, 'orgId'), p(req, 'vehicleId'), p(req, 'assignmentId'))
    sendSuccess(res, result)
  } catch (err) { next(err) }
}

// ── Operator brief ───────────────────────────────────────────────────────────
// GET /organisations/:orgId/vehicles/:vehicleId/brief
//
// Two or three sentences on what this unit has done today: who is driving,
// since when, distance covered, fuel taken on, where it was sent and when it
// is due back. Every figure is measured server-side; the model only phrases
// them, and writes nothing when there is no key (see vehicle-brief).

export const getBrief: RequestHandler = async (req, res, next) => {
  try {
    // `?fresh=1` once per click on the unit: measured and phrased anew.
    const brief = await getVehicleBrief(p(req, 'orgId'), p(req, 'vehicleId'), { fresh: req.query.fresh === '1' })
    sendSuccess(res, brief)
  } catch (err) { next(err) }
}

// GET /organisations/:orgId/vehicles/:vehicleId/insight
// The newest stored insight, at once (see vehicle-insight). null when the unit
// has none and no signals to write one from.
export const getInsight: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getVehicleInsight(p(req, 'orgId'), p(req, 'vehicleId')))
  } catch (err) { next(err) }
}
