import { rateLimit } from 'express-rate-limit'
import { env } from '../config/env.js'

const base = {
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  message: { statusCode: 429, status: 'error', message: 'Too many requests, please try again later' },
}

export const globalLimiter = rateLimit({ ...base, max: env.RATE_LIMIT_MAX })
export const authLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, max: 20 })

/**
 * Relaxed limit for high-frequency device telemetry ingestion endpoints
 * (POST /trips, POST /engine-sessions, POST /fuel/fillings, POST /fuel/thefts).
 * These are called by GPS/FLS hardware on a per-event basis.
 */
export const ingestLimiter = rateLimit({ ...base, max: env.INGEST_RATE_LIMIT_MAX })
