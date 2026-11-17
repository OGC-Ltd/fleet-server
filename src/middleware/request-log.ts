/**
 * One log line per request, with the client's address: the app's own record
 * of who called what, beside nginx's access log (which sees every request,
 * including the ones that never reach the app, but not who was signed in).
 *
 *   { msg: 'request', ip, xff, method, path, query, route, status, ms, bytes,
 *     userId, orgId, ua, referer, aborted, trace_id, span_id }
 *
 * `ip` is `req.ip`: the client as resolved through the proxies the app trusts
 * (lib/trust-proxy). `xff` is the raw X-Forwarded-For as received, kept for
 * audits; it is client-controlled and never used to decide anything.
 *
 * Written when the response closes, so `ms` is the full time and a client that
 * hung up shows `aborted: true`. A live stream (SSE) also logs when it opens,
 * because it can stay open for hours.
 *
 * The same address goes onto the request's trace span (`client.address`), with
 * the user and organisation, so a trace in Jaeger says who made it.
 *
 * Mounted first in app.ts, before the rate limiter, so refused requests (429)
 * are logged too. /health is skipped: Docker calls it every 30 s.
 */
import type { NextFunction, Request, Response } from 'express'
import { trace, type Span } from '@opentelemetry/api'
import { logger } from '../lib/logger.js'
import { scrubQuery } from '../lib/scrub-query.js'

const ORG_IN_PATH = /^\/api\/v1\/organisations\/([^/?]+)/

function orgOf(req: Request): string | undefined {
  return req.authz?.orgId ?? ORG_IN_PATH.exec(req.originalUrl)?.[1]
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v.join(', ') : v
}

function tagSpan(span: Span, req: Request): void {
  const userId = req.user?.id ?? req.authz?.userId
  if (userId) span.setAttribute('enduser.id', userId)
  const orgId = orgOf(req)
  if (orgId) span.setAttribute('fleet.org.id', orgId)
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health') return next()

  const t0 = performance.now()
  const ip = req.ip ?? req.socket.remoteAddress ?? null
  const url = req.originalUrl
  const q = url.indexOf('?')
  const path = q === -1 ? url : url.slice(0, q)
  const query = q === -1 ? undefined : scrubQuery(url.slice(q + 1))

  const span = trace.getActiveSpan()
  if (span && ip) span.setAttribute('client.address', ip)

  const base = () => ({
    ip,
    xff: header(req, 'x-forwarded-for'),
    method: req.method,
    path,
    query,
    userId: req.user?.id ?? req.authz?.userId,
    orgId: orgOf(req),
    ua: header(req, 'user-agent'),
    referer: header(req, 'referer'),
  })

  // Just before the headers go out:
  //  - the span gets the user and organisation, which auth has resolved by
  //    now, while it is still open (by 'finish' the http instrumentation may
  //    already have ended it);
  //  - a live stream (SSE) logs that it opened, since its 'close' can be hours away.
  let streamLogged = false
  const writeHead = res.writeHead
  res.writeHead = function (this: Response, ...args: unknown[]) {
    if (span) tagSpan(span, req)
    const out = (writeHead as (...a: unknown[]) => Response).apply(this, args)
    if (!streamLogged && String(res.getHeader('content-type') ?? '').startsWith('text/event-stream')) {
      streamLogged = true
      logger.info({ ...base(), stream: 'opened' }, 'request')
    }
    return out
  } as typeof res.writeHead

  res.once('close', () => {
    const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : undefined
    const len = res.getHeader('content-length')
    logger.info(
      {
        ...base(),
        route,
        status: res.statusCode,
        ms: Math.round(performance.now() - t0),
        bytes: len === undefined ? undefined : Number(len),
        aborted: !res.writableFinished,
        ...(streamLogged && { stream: 'closed' }),
      },
      'request',
    )
  })

  next()
}
