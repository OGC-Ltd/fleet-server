/**
 * Webhook authentication for provider callbacks (RaiFactorySuite).
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

// Headers a sender may carry an HMAC signature in. The provider's exact
// convention isn't documented, so accept the common ones rather than forcing
// a contract negotiation before any alert can land.
const SIGNATURE_HEADERS = [
  'x-signature',
  'x-hub-signature-256',
  'x-webhook-signature',
  'x-factory-signature',
  'x-factorysuite-signature',
  'x-rai-signature',
  'x-signature-256',
] as const

// Headers a sender may carry the shared secret VERBATIM in.
const SECRET_HEADERS = [
  'x-webhook-secret',
  'x-factory-suite-hook',
  'x-factorysuite-hook',
  'x-hook-secret',
  'x-api-key',
  'x-webhook-token',
] as const

const header = (req: { headers: Record<string, unknown> }, name: string): string | null => {
  const v = req.headers[name]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Strip a `sha256=` / `hmac-sha256=` style prefix and normalise. */
function normaliseSignature(sig: string): string {
  const s = sig.trim()
  const eq = s.indexOf('=')
  return (eq > 0 && eq < 16 ? s.slice(eq + 1) : s).trim()
}

/**
 * Every secret a FactorySuite webhook may be signed with. Each webhook
 * registered there has its own: WORK_PLANNER_HOOK (the default from 19 Nov
 * 2026, carrying FactorySuite's whole event list) and FACTORY_SUITE_HOOK (the
 * original: alerts, dispatches, movements, weighments;
 * CONTROLTECH_WEBHOOK_SECRET is its older name). Both post to the same URL.
 */
export function webhookSecrets(): string[] {
  return namedSecrets().map(s => s.secret)
}

/** Which FactorySuite webhook a delivery came from: the one whose secret it carried. */
export type WebhookSource = 'factory_suite' | 'work_planner'

// WORK_PLANNER_HOOK is the default from 19 Nov 2026: FactorySuite's events are
// ticked on that webhook. The original one stays accepted while it exists.
function namedSecrets(): Array<{ source: WebhookSource; secret: string }> {
  return [
    { source: 'work_planner' as const, secret: env.WORK_PLANNER_HOOK },
    { source: 'factory_suite' as const, secret: env.FACTORY_SUITE_HOOK || env.CONTROLTECH_WEBHOOK_SECRET },
  ].filter(s => Boolean(s.secret))
}

/** The webhook an accepted delivery was authenticated as (set by webhookAuth). */
export function webhookSourceOf(req: unknown): WebhookSource | null {
  return (req as { webhookSource?: WebhookSource }).webhookSource ?? null
}

export const webhookAuth: RequestHandler = (req, _res, next) => {
  const named = namedSecrets()
  const secrets = named.map(s => s.secret)
  // Tags the request with the webhook whose secret matched. Both webhooks may
  // be subscribed to the same event, so this is how a repeat is traced.
  const accept = (index: number) => {
    (req as { webhookSource?: WebhookSource }).webhookSource = named[index]?.source
    return next()
  }
  if (secrets.length === 0) {
    // Fail closed: an unset secret must never mean "allow anyone to inject
    // alerts into the operations feed".
    logger.error('No FactorySuite webhook secret is set (WORK_PLANNER_HOOK, FACTORY_SUITE_HOOK) — rejecting webhook delivery')
    return next(new UnauthorizedError('Webhook receiver is not configured'))
  }

  // 1. HMAC over the raw body, in hex or base64, under any known header.
  const raw = (req as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0)
  const expected = secrets.map(s => ({
    hex:    createHmac('sha256', s).update(raw).digest('hex'),
    base64: createHmac('sha256', s).update(raw).digest('base64'),
  }))

  for (const name of SIGNATURE_HEADERS) {
    const sig = header(req, name)
    if (!sig) continue
    const received = normaliseSignature(sig)
    // Every secret is compared, not just until one matches, so the time
    // taken does not say which webhook a signature was checked against.
    let match = -1
    expected.forEach((e, i) => {
      if (safeEqual(e.hex, received.toLowerCase()) || safeEqual(e.base64, received)) match = i
    })
    if (match >= 0) return accept(match)
    // A present-but-wrong signature is a hard failure: don't fall through to
    // the weaker shared-secret path, or a bad signature could be bypassed by
    // also sending the secret in the clear.
    logRejection(req)
    return next(new UnauthorizedError('Invalid webhook signature'))
  }

  // 2. The shared secret sent verbatim, under any known header.
  const secretIndex = (provided: string) => {
    let match = -1
    secrets.forEach((s, i) => { if (safeEqual(s, provided)) match = i })
    return match
  }
  for (const name of SECRET_HEADERS) {
    const provided = header(req, name)
    if (!provided) continue
    const match = secretIndex(provided.trim())
    if (match >= 0) return accept(match)
  }

  // 3. Authorization: Bearer <secret> (or the bare secret).
  const auth = header(req, 'authorization')
  if (auth) {
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim()
    const match = secretIndex(token)
    if (match >= 0) return accept(match)
  }

  logRejection(req)
  return next(new UnauthorizedError('Missing or invalid webhook credentials'))
}

/**
 * Diagnostic for a rejected delivery: which auth-ish headers the caller sent
 * and how large the body was. Values are truncated — enough to identify
 * the scheme (hex vs base64 HMAC, bearer token, custom header name) without
 * writing a credential to the log.
 *
 * Replay: nothing here binds a delivery to a time, because the provider sends
 * no timestamp to sign. What limits a replayed delivery today is downstream —
 * every event is upserted on the provider's own id. A signed timestamp header
 * (rejecting anything outside a few minutes) needs the provider to send one.
 */
function logRejection(req: { headers: Record<string, unknown>; rawBody?: Buffer }): void {
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
    // Not the expected signature, not even a prefix of it: for a body the
    // caller chose, that is signature material handed to whoever is probing.
  }, 'Webhook delivery REJECTED — no accepted credential matched')
}
