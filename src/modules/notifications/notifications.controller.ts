import type { Request, Response } from 'express'
import { pushService }              from './notifications.service.js'
import { registerDashboardClient, emitDashboardHeartbeat, replayDashboardPositions } from '../../lib/sse.js'
import { sendSuccess, sendError }   from '../../core/response/response.js'
import { logger }                   from '../../lib/logger.js'

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
  logger.debug({ orgId, replayed }, 'Dashboard SSE client connected')

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
