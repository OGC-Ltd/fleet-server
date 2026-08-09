import { AppError } from './AppError.js'

export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404)
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409)
  }
}

export class UnprocessableError extends AppError {
  constructor(message = 'Unprocessable entity') {
    super(message, 422)
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, 429)
  }
}

/**
 * The request was valid but the database could not answer it in the time it is
 * allowed. Distinct from a 500: nothing is broken, the work was simply too big,
 * and the same call with a narrower window will succeed.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable') {
    super(message, 503)
  }
}

/** Thrown when a Zod parse fails — carries structured field errors. */
export class ValidationError extends AppError {
  public readonly errors: Record<string, string[]>

  constructor(errors: Record<string, string[]>) {
    super('Validation failed', 400)
    this.errors = errors
  }
}
