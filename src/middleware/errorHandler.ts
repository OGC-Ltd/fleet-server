import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../core/errors/AppError.js'
import { ValidationError } from '../core/errors/errors.js'
import { sendError } from '../core/response/response.js'
import { logger } from '../lib/logger.js'

const PRISMA_UNIQUE_VIOLATION = 'P2002'
const PRISMA_NOT_FOUND = 'P2025'
const PRISMA_FK_VIOLATION = 'P2003'

interface PrismaClientKnownRequestError extends Error {
  code: string
  meta?: { target?: string[]; cause?: string }
}

function isPrismaError(err: unknown): err is PrismaClientKnownRequestError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>)['code'] === 'string'
  )
}

/** A 4xx status set by body-parser (http-errors), or null for anything else. */
function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown }
  if (typeof e.type !== 'string' || !e.type.startsWith('entity.') && e.type !== 'charset.unsupported' && e.type !== 'encoding.unsupported') return null
  const status = typeof e.status === 'number' ? e.status : e.statusCode
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return void sendError(res, 400, 'Validation failed', err.flatten().fieldErrors as Record<string, string[]>)
  }

  if (err instanceof ValidationError) {
    return void sendError(res, 400, err.message, err.errors)
  }

  if (err instanceof AppError) {
    return void sendError(res, err.statusCode, err.message)
  }

  if (isPrismaError(err)) {
    if (err.code === PRISMA_UNIQUE_VIOLATION) {
      const field = err.meta?.target?.join(', ') ?? 'field'
      return void sendError(res, 409, `A record with that ${field} already exists`)
    }
    if (err.code === PRISMA_NOT_FOUND) {
      return void sendError(res, 404, err.meta?.cause ?? 'Record not found')
    }
    if (err.code === PRISMA_FK_VIOLATION) {
      return void sendError(res, 400, 'Referenced record does not exist')
    }
  }

  if (err instanceof Error) {
    if (err.name === 'JsonWebTokenError') return void sendError(res, 401, 'Invalid token')
    if (err.name === 'TokenExpiredError') return void sendError(res, 401, 'Token expired')
    if (err.name === 'NotBeforeError') return void sendError(res, 401, 'Token not yet valid')
  }

  // The body parser's own failures (malformed JSON, a body over the size
  // limit, an unsupported charset) carry the client-error status they mean.
  // Without this they fell through to a 500 and were logged as system errors.
  const status = clientErrorStatus(err)
  if (status !== null) {
    return void sendError(res, status, status === 413 ? 'Request body too large' : 'Malformed request body')
  }

  logger.error({ err }, 'Unhandled system error')
  sendError(res, 500, 'An unexpected error occurred')
}
