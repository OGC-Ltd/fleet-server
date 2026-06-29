import type { Response } from 'express'

export interface PaginationMeta {
  total?: number
  page?: number
  limit?: number
  cursor?: string | null
  hasNextPage?: boolean
}

export interface SuccessPayload<T> {
  statusCode: number
  status: 'success'
  data: T
  meta?: PaginationMeta
}

export interface ErrorPayload {
  statusCode: number
  status: 'error'
  message: string
  errors?: Record<string, string[]>
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: PaginationMeta,
): void {
  const body: SuccessPayload<T> = { statusCode, status: 'success', data }
  if (meta) body.meta = meta
  res.status(statusCode).json(body)
}

export function sendError(res: Response, statusCode: number, message: string, errors?: Record<string, string[]>): void {
  const body: ErrorPayload = { statusCode, status: 'error', message }
  if (errors) body.errors = errors
  res.status(statusCode).json(body)
}
