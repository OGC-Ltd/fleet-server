import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './cargo.repository.js'
import type { UpsertCargo } from './cargo.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const getManifest: RequestHandler = async (req, res, next) => {
  try {
    const manifest = await repo.getManifest(p(req, 'tripId'), p(req, 'orgId'))
    if (manifest === null) throw new NotFoundError('Trip not found')
    sendSuccess(res, manifest)
  } catch (err) { next(err) }
}

export const upsertManifest: RequestHandler = async (req, res, next) => {
  try {
    const manifest = await repo.upsertManifest(p(req, 'tripId'), p(req, 'orgId'), req.body as UpsertCargo)
    if (!manifest) throw new NotFoundError('Trip not found')
    sendSuccess(res, manifest, 200)
  } catch (err) { next(err) }
}

export const deleteManifest: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.deleteManifest(p(req, 'tripId'), p(req, 'orgId'))
    if (!result) throw new NotFoundError('Trip not found')
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}
