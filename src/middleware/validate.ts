import type { RequestHandler } from 'express'
import type { ZodTypeAny } from 'zod'

/**
 * Validates req.body against a Zod schema.
 * Throws ZodError on failure — caught and formatted by errorHandler.
 */
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

/**
 * Validates req.query against a Zod schema.
 */
export const validateQuery =
  (schema: ZodTypeAny): RequestHandler =>
  async (req, _res, next) => {
    try {
      // Cast needed: ParsedQs is narrower than the Zod output (which may include coerced numbers/dates).
      // Downstream code receives the fully-typed, coerced object via `req.query as unknown as MySchema`.
      (req as unknown as { query: unknown }).query = await schema.parseAsync(req.query)
      next()
    } catch (err) {
      next(err)
    }
  }
