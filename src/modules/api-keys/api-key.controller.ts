import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './api-key.repository.js'
import type { CreateApiKey, UpdateApiKey } from './api-key.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const list: RequestHandler = async (req, res, next) => {
  try {
    const keys = await repo.findAll(p(req, 'orgId'))
    sendSuccess(res, keys)
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    const key = await repo.create(p(req, 'orgId'), req.user!.id, req.body as CreateApiKey)
    sendSuccess(res, key, 201)
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    const key = await repo.findById(p(req, 'keyId'), p(req, 'orgId'))
    if (!key) throw new NotFoundError('API key not found')
    sendSuccess(res, key)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    const key = await repo.update(p(req, 'keyId'), p(req, 'orgId'), req.body as UpdateApiKey)
    if (!key) throw new NotFoundError('API key not found')
    sendSuccess(res, key)
  } catch (err) { next(err) }
}

export const revoke: RequestHandler = async (req, res, next) => {
  try {
    const key = await repo.revoke(p(req, 'keyId'), p(req, 'orgId'))
    if (!key) throw new NotFoundError('API key not found')
    sendSuccess(res, key)
  } catch (err) { next(err) }
}
