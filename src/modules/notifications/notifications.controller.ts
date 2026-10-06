import type { Request, Response } from 'express'
import { pushService }              from './notifications.service.js'
import { registerDashboardClient, writeHeartbeat, replayDashboardPositions, replayDashboardFeed } from '../../lib/sse.js'
import { sendSuccess, sendError }   from '../../core/response/response.js'
import { logger }                   from '../../lib/logger.js'
import { getNotifications }         from '../../lib/notifications/notification.reader.js'

// ─── GET /api/v1/organisations/:orgId/notifications ───────────────────────
// Notification history. Served from the Redis cache when it can answer in
// full, otherwise from Postgres (which also re-warms the cache) — see
// lib/notifications/notification.reader.
//
// Query: ?limit=1..200 (default 50)  ?before=<ISO timestamp> to page back.
//        ?alertType=fuelFilling,fuelInconsistency   ?severity=critical
//        ?vehicleId=<cuid>  — one unit's history, for the map's per-vehicle feed
//
// Until this existed there was no way to read notification history at all:
// clients had the live SSE stream and a 60-item in-memory buffer, and a
// restart or a reload past that window simply lost it.
//
// The filters exist because one chronological feed cannot serve a fleet that
// emits thirteen zone crossings a minute AND fuel events that surface up to two
// hours after they happened: correctly ordered, the fuel event is several
// hundred rows down. See NotificationQuery.

/** `?alertType=a,b` or a repeated `?alertType=a&alertType=b`, both accepted. */
function csv(v: unknown): string[] | undefined {
  const parts = (Array.isArray(v) ? v : [v])
    .flatMap((s) => String(s ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

export async function listNotifications(req: Request, res: Response) {
  const { orgId } = req.params as { orgId: string }
  const { limit, before, alertType, severity, vehicleId, day } = req.query as Record<string, unknown>

  const parsedLimit = limit ? Number(limit) : undefined
  if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
    return sendError(res, 400, 'limit must be a number')
  }

  // Validated HERE rather than let through to a silently-ignored filter: a
  // caller who mistypes a day and gets the whole history back has been given a
  // wrong answer that looks right.
  const dayStr = day ? String(Array.isArray(day) ? day[0] : day) : undefined
  if (dayStr !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
    return sendError(res, 400, 'day must be YYYY-MM-DD')
  }

  let beforeDate: Date | undefined
  if (before) {
    beforeDate = new Date(String(before))
    if (Number.isNaN(beforeDate.getTime())) {
      return sendError(res, 400, 'before must be an ISO-8601 timestamp')
    }
  }

  try {
    const page = await getNotifications(orgId, {
      limit:      parsedLimit,
      before:     beforeDate,
      alertTypes: csv(alertType),
      severities: csv(severity),
      // One vehicle only — a repeated param would be ambiguous, so take the
      // first and ignore the rest rather than silently unioning them.
      vehicleId:  vehicleId ? String(Array.isArray(vehicleId) ? vehicleId[0] : vehicleId) : undefined,
      day:        dayStr,
    })
    return sendSuccess(res, {
      notifications: page.items,
      count:         page.items.length,
      // Cursor for the next page — omitted when this page is the end.
      nextBefore:    page.items.length > 0 ? page.items[page.items.length - 1]!.ts : null,
      servedFrom:    page.source,
    })
  } catch (err) {
    logger.error({ err, orgId }, 'Failed to list notifications')
    return sendError(res, 500, 'Could not load notifications')
  }
}

// ─── GET /api/v1/notifications/vapid-key ──────────────────────────────────
// Public endpoint — called by the Service Worker before subscribing.

export async function getVapidKey(_req: Request, res: Response) {
  if (!pushService.isEnabled) {
    return sendError(res, 503, 'Web Push is not configured on this server')
  }
  return sendSuccess(res, { publicKey: pushService.vapidPublicKey })
}

// ─── GET /api/v1/organisations/:orgId/live ────────────────────────────────
// Org-wide SSE dashboard stream.
// Events:
//   position  — vehicle state snapshot (lat, lng, speed, fuel, flags …)
//   alert     — fleet alert (overspeeding, fuel theft, geofence violation …)
//   heartbeat — keep-alive every 25 s so proxies don't drop the connection

const HEARTBEAT_MS = 25_000

export async function dashboardStream(req: Request, res: Response) {
  const { orgId } = req.params as { orgId: string }
  // Set by requireOrgAccess. NULL means the whole fleet; a Set means this
  // client is only ever told about those vehicles — in the replay below and in
  // every live event for as long as the connection lasts. A stream authorised
  // once at handshake cannot be filtered later by the route guard, so the scope
  // has to travel with the connection.
  const authz = (req as Request & { authz?: { vehicleIds: Set<string> | null; userId: string } }).authz
  const vehicleIds = authz?.vehicleIds ?? null

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')   // disable Nginx buffering
  res.flushHeaders()

  // Send an immediate connected confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ orgId, ts: new Date().toISOString() })}\n\n`)

  // Changed vehicles and fields only (`position_delta`), for a client that can
  // rebuild the full frame — see lib/sse positionDelta. Opt-in, so a browser
  // still running an older build keeps getting full `position` frames.
  const delta = req.query['delta'] === '1'

  // This org's recent activity, so the Live Feed panel has history. Async
  // because it reads the durable store (Redis, then Postgres) rather than an
  // in-memory buffer — see replayDashboardFeed. Awaited before the client is
  // registered so the replay cannot interleave with a live item arriving
  // mid-read, which would land an older event above a newer one.
  const feedReplayed = await replayDashboardFeed(orgId, res, 40, vehicleIds)
    .catch((err) => { logger.warn({ err, orgId }, 'Feed replay failed — panel starts empty and fills from live events'); return 0 })

  // Then the fleet's last-known positions, so this client is in sync with
  // every other open browser immediately, not after the next poll tick.
  // AFTER the await and in the same turn as the registration below: deltas
  // are taken against the positions as they stand, so nothing may be emitted
  // between the replay that sets this client's base and the moment it starts
  // receiving deltas. (Replayed before the await, a position arriving during
  // the feed read was lost to this client, and every later delta for that
  // vehicle would have applied to a stale base.)
  const replayed = replayDashboardPositions(orgId, res, vehicleIds)
  logger.debug({ orgId, replayed, feedReplayed, delta }, 'Dashboard SSE client connected')

  const cleanup   = registerDashboardClient(orgId, res, { vehicleIds, userId: authz?.userId, delta })
  // Its OWN socket only — see writeHeartbeat for why this is not a broadcast.
  const heartbeat = setInterval(() => writeHeartbeat(res), HEARTBEAT_MS)

  req.on('close', () => {
    cleanup()
    clearInterval(heartbeat)
    logger.debug({ orgId }, 'Dashboard SSE client disconnected')
  })
}

// ─── POST /api/v1/organisations/:orgId/notifications/subscribe ────────────

export async function subscribe(req: Request, res: Response) {
  const { orgId }   = req.params as { orgId: string }
  const userId      = (req as Request & { user?: { id: string } }).user?.id ?? null
  const { subscription } = req.body as { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }

  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return sendError(res, 400, 'Invalid push subscription object')
  }

  await pushService.subscribe(orgId, userId, subscription, req.headers['user-agent'])
  return sendSuccess(res, null, 201)
}

// ─── DELETE /api/v1/organisations/:orgId/notifications/subscribe ──────────

export async function unsubscribe(req: Request, res: Response) {
  const { endpoint } = req.body as { endpoint: string }
  if (!endpoint) return sendError(res, 400, 'endpoint is required')
  await pushService.unsubscribe(endpoint)
  return sendSuccess(res, null)
}
