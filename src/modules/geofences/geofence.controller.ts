import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './geofence.repository.js'
import type { CreateGeofence, UpdateGeofence, GeofenceListQuery } from './geofence.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.findAll(p(req, 'orgId'), req.query as unknown as GeofenceListQuery)
    sendSuccess(res, result.data, 200, { cursor: result.cursor, hasNextPage: result.hasNextPage })
  } catch (err) { next(err) }
}

export const geojson: RequestHandler = async (req, res, next) => {
  try {
    const fc = await repo.findAllAsGeoJSON(p(req, 'orgId'))
    sendSuccess(res, fc)
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    const fence = await repo.create(p(req, 'orgId'), req.user!.id, req.body as CreateGeofence)
    sendSuccess(res, fence, 201)
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    const fence = await repo.findById(p(req, 'geofenceId'), p(req, 'orgId'))
    if (!fence) throw new NotFoundError('Geofence not found')
    sendSuccess(res, fence)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    const fence = await repo.update(p(req, 'geofenceId'), p(req, 'orgId'), req.body as UpdateGeofence)
    if (!fence) throw new NotFoundError('Geofence not found')
    sendSuccess(res, fence)
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    const deleted = await repo.remove(p(req, 'geofenceId'), p(req, 'orgId'))
    if (!deleted) throw new NotFoundError('Geofence not found')
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

export const assignVehicle: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.assignVehicle(p(req, 'geofenceId'), p(req, 'orgId'), req.body.vehicleId as string, req.user!.id)
    if (!result) throw new NotFoundError('Geofence not found')
    sendSuccess(res, result, 201)
  } catch (err) { next(err) }
}

export const unassignVehicle: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.unassignVehicle(p(req, 'geofenceId'), p(req, 'orgId'), p(req, 'vehicleId'))
    if (!result) throw new NotFoundError('Geofence not found')
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

export const listVehicles: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.listVehicles(p(req, 'geofenceId'), p(req, 'orgId'))
    if (!result) throw new NotFoundError('Geofence not found')
    sendSuccess(res, result)
  } catch (err) { next(err) }
}

export const listViolations: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.listViolations(p(req, 'geofenceId'), p(req, 'orgId'))
    if (!result) throw new NotFoundError('Geofence not found')
    sendSuccess(res, result)
  } catch (err) { next(err) }
}
