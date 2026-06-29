import type { RequestHandler } from 'express'
import type { ZodTypeAny } from 'zod'

export const validateBody =
  (schema: ZodTypeAny): RequestHandler =>
  async (req, _res, next) => {
    try {
      req.body = await schema.parseAsync(req.body)
      next()
    } catch (err) {
      next(err)
    }
  }

export const validateQuery =
  (schema: ZodTypeAny): RequestHandler =>
  async (req, _res, next) => {
    try {
      const parsed = await schema.parseAsync(req.query)
      Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true })
      next()
    } catch (err) {
      next(err)
    }
  }
