import type { Request, Response, NextFunction } from 'express'
import { logger } from '../../lib/logger.js'
import { sendSuccess } from '../../core/response/response.js'
import { ingestAlerts, type ControltechAlert } from './controltech-alerts.service.js'
import { handleDispatch, handleMovement } from './controltech-events.service.js'
import { ingestWialonNotifications } from './wialon-notifications.service.js'
import {
  controltechAlertSchema,
  controltechDispatchSchema,
  controltechMovementSchema,
  wialonNotificationSchema,
  unwrapEvent,
} from './webhooks.schema.js'

/**
 * POST /webhook/rai
 *
 * Controltech posts three event types here:
 *   alert.created     → operational alert (persisted + Live Feed)
 *   dispatch.created  → driver↔vehicle assignment (persisted + Live Feed)
 *   movement.created  → gate crossing (Live Feed only; carries no coordinates)
 *
 * A 4xx makes their sender retry a few times and then DROP the event, so an
 * unrecognised shape must never fail the request: acknowledge it, log the
 * shape so it can be wired up, and move on. Persistence is idempotent on the
 * provider's own ids, so a retry is harmless.
 */
export async function controltechAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const { event, items } = unwrapEvent(req.body)
    const kind = (event ?? '').toLowerCase()

    const alerts: ControltechAlert[] = []
    const unmapped: unknown[] = []
    let dispatches = 0
    let movements  = 0

    const wialonNotifications: Parameters<typeof ingestWialonNotifications>[0] = []

    for (const item of items) {
      // Wialon's "Send a request" action posts a `notification` field. It has
      // no event envelope of its own, so the field itself is the marker.
      const wn = wialonNotificationSchema.safeParse(item)
      if (wn.success && (kind.startsWith('wialon') || !kind)) {
        wialonNotifications.push(wn.data)
        continue
      }

      // Prefer the declared event name; fall back to shape-sniffing so a
      // renamed event still lands somewhere sensible.
      if (kind.startsWith('dispatch')) {
        const d = controltechDispatchSchema.safeParse(item)
        if (d.success) { if (await handleDispatch(d.data)) dispatches++; continue }
      }
      if (kind.startsWith('movement')) {
        const m = controltechMovementSchema.safeParse(item)
        if (m.success) { if (await handleMovement(m.data)) movements++; continue }
      }

      const a = controltechAlertSchema.safeParse(item)
      if (a.success && (kind.startsWith('alert') || !kind)) { alerts.push(a.data); continue }

      unmapped.push(item)
    }

    const result = alerts.length > 0 ? await ingestAlerts(alerts, 'webhook') : null
    const wialon = wialonNotifications.length > 0
      ? await ingestWialonNotifications(wialonNotifications)
      : null

    if (unmapped.length > 0) {
      logger.info(
        { event, count: unmapped.length, sample: unmapped[0], keys: Object.keys((unmapped[0] ?? {}) as object) },
        'Webhook event received that we do not map yet',
      )
    }
    if (result || dispatches || movements || wialon) {
      logger.info(
        { event, dispatches, movements, wialon, ...(result ?? {}) },
        'Provider webhook processed',
      )
    }

    sendSuccess(res, {
      event,
      received: items.length,
      alerts:   alerts.length,
      dispatches,
      movements,
      wialonNotifications: wialon?.created ?? 0,
      ignored:  unmapped.length,
      ...(result ?? {}),
    })
  } catch (err) {
    next(err)
  }
}
