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

  logger.error({ err }, 'Unhandled system error')
  sendError(res, 500, 'An unexpected error occurred')
}
