/**
 * Base class for all operational (expected) errors.
 * Operational errors are safe to surface to the client.
 * System errors (unexpected) must NOT extend this class — they fall through to the 500 handler.
 */
export class AppError extends Error {
  public readonly statusCode: number
  public readonly isOperational = true

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
    this.name = this.constructor.name
    Error.captureStackTrace(this, this.constructor)
  }
}
