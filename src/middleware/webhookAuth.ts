/**
 * Webhook authentication for provider callbacks (Controltech EA).
 *
 * Two accepted schemes, in order of preference — which one is used depends on
 * what the provider can send:
 *
 *  1. HMAC signature (preferred). The provider signs the RAW request body with
 *     the shared secret and sends it as `X-Signature` (bare hex, or prefixed
 *     `sha256=<hex>`). Proves the body wasn't tampered with in transit and
 *     that the caller holds the secret without ever putting it on the wire.
 *
 *  2. Shared secret header. `X-Webhook-Secret: <secret>` compared in constant
 *     time. Simpler, but the secret travels on every request — only acceptable
 *     over TLS.
 *
 * Both compare with timingSafeEqual so a byte-by-byte timing side channel
 * can't be used to guess the secret.
 *
 * Requires the raw body, which app.ts captures via express.json's `verify`
 * hook (req.rawBody) — re-serialising the parsed object would change byte
 * order/whitespace and break the signature.
 */

import type { RequestHandler } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import { env } from '../config/env.js'
import { UnauthorizedError } from '../core/errors/errors.js'
import { logger } from '../lib/logger.js'

/** Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the reject path costs the same either way.
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export const webhookAuth: RequestHandler = (req, _res, next) => {
  const secret = env.CONTROLTECH_WEBHOOK_SECRET
  if (!secret) {
    // Fail closed: an unset secret must never mean "allow anyone to inject
    // alerts into the operations feed".
    logger.error('CONTROLTECH_WEBHOOK_SECRET is not set — rejecting webhook delivery')
    return next(new UnauthorizedError('Webhook receiver is not configured'))
  }

  const signature = req.headers['x-signature'] ?? req.headers['x-hub-signature-256']
  if (typeof signature === 'string' && signature.length > 0) {
    const raw = (req as { rawBody?: Buffer }).rawBody
    if (!raw) return next(new UnauthorizedError('Raw body unavailable for signature check'))
    const expected = createHmac('sha256', secret).update(raw).digest('hex')
    const received = signature.startsWith('sha256=') ? signature.slice(7) : signature
    if (!safeEqual(expected, received.trim().toLowerCase())) {
      return next(new UnauthorizedError('Invalid webhook signature'))
    }
    return next()
  }

  const provided = req.headers['x-webhook-secret']
  if (typeof provided === 'string' && safeEqual(secret, provided)) return next()

  logRejection(req, secret)
  return next(new UnauthorizedError('Missing or invalid webhook credentials'))
}

/**
 * Diagnostic for a rejected delivery: which auth-ish headers the caller sent
 * and what we would have accepted. Values are truncated — enough to identify
 * the scheme (hex vs base64 HMAC, bearer token, custom header name) without
 * writing a credential to the log.
 */
function logRejection(req: { headers: Record<string, unknown>; rawBody?: Buffer }, secret: string): void {
  const raw  = req.rawBody ?? Buffer.alloc(0)
  const clip = (v: unknown) => {
    const s = String(v ?? '')
    return s.length <= 12 ? s : `${s.slice(0, 8)}…(${s.length})`
  }
  const authish = Object.entries(req.headers)
    .filter(([k]) => /signature|auth|secret|hmac|token|api[-_]?key|sign/i.test(k))
    .map(([k, v]) => `${k}=${clip(v)}`)

  logger.warn({
    headerNames: Object.keys(req.headers),
    authHeaders: authish.length > 0 ? authish : '(none)',
    bodyBytes:   raw.length,
    expectedHex:    clip(createHmac('sha256', secret).update(raw).digest('hex')),
    expectedBase64: clip(createHmac('sha256', secret).update(raw).digest('base64')),
  }, 'Webhook delivery REJECTED — no accepted credential matched')
}
