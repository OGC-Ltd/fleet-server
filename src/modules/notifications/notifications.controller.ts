import type { Request, Response } from 'express'
import { pushService }              from './notifications.service.js'
import { registerDashboardClient, emitDashboardHeartbeat, replayDashboardPositions, replayDashboardFeed } from '../../lib/sse.js'
import { sendSuccess, sendError }   from '../../core/response/response.js'
import { logger }                   from '../../lib/logger.js'
import { getNotifications }         from '../../lib/notifications/notification.reader.js'

// ─── GET /api/v1/organisations/:orgId/notifications ───────────────────────
// Notification history. Served from the Redis cache when it can answer in
// full, otherwise from Postgres (which also re-warms the cache) — see
// lib/notifications/notification.reader.
//
// Query: ?limit=1..200 (default 50)  ?before=<ISO timestamp> to page back.
//
// Until this existed there was no way to read notification history at all:
// clients had the live SSE stream and a 60-item in-memory buffer, and a
// restart or a reload past that window simply lost it.

export async function listNotifications(req: Request, res: Response) {
  const { orgId } = req.params as { orgId: string }
  const { limit, before } = req.query as { limit?: string; before?: string }

  const parsedLimit = limit ? Number(limit) : undefined
  if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
    return sendError(res, 400, 'limit must be a number')
  }

  let beforeDate: Date | undefined
  if (before) {
    beforeDate = new Date(before)
    if (Number.isNaN(beforeDate.getTime())) {
      return sendError(res, 400, 'before must be an ISO-8601 timestamp')
    }
  }

  try {
    const page = await getNotifications(orgId, { limit: parsedLimit, before: beforeDate })
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

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')   // disable Nginx buffering
  res.flushHeaders()

  // Send an immediate connected confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ orgId, ts: new Date().toISOString() })}\n\n`)

  // Replay the fleet's last-known positions so this client is in sync with
  // every other open browser immediately, not after the next poll tick.
  const replayed = replayDashboardPositions(orgId, res)
  // …and this org's recent activity, so the Live Feed panel has history. Async
  // because it reads the durable store (Redis, then Postgres) rather than an
  // in-memory buffer — see replayDashboardFeed. Awaited before the client is
  // registered so the replay cannot interleave with a live item arriving
  // mid-read, which would land an older event above a newer one.
  const feedReplayed = await replayDashboardFeed(orgId, res)
    .catch((err) => { logger.warn({ err, orgId }, 'Feed replay failed — panel starts empty and fills from live events'); return 0 })
  logger.debug({ orgId, replayed, feedReplayed }, 'Dashboard SSE client connected')

  const cleanup   = registerDashboardClient(orgId, res)
  const heartbeat = setInterval(() => {
    try { emitDashboardHeartbeat(orgId) } catch { /* ignore */ }
  }, HEARTBEAT_MS)

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
