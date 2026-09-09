import type { Request, Response, NextFunction } from 'express'
import { logger } from '../../lib/logger.js'
import { sendSuccess } from '../../core/response/response.js'
import { ingestAlerts, type RaiFactorySuiteAlert } from './raifactorysuite-alerts.service.js'
import { handleDispatch, handleMovement, handleSale } from './raifactorysuite-events.service.js'
import { ingestWialonNotifications } from './wialon-notifications.service.js'
import {
  raiFactorySuiteAlertSchema,
  raiFactorySuiteDispatchSchema,
  raiFactorySuiteMovementSchema,
  raiFactorySuiteSaleSchema,
  wialonNotificationSchema,
  looksLikeSale,
  unwrapEvent,
} from './webhooks.schema.js'

/**
 * POST /webhook/rai
 *
 * RaiFactorySuite posts three event types here:
 *   alert.created     → operational alert (persisted + Live Feed)
 *   dispatch.created  → driver↔vehicle assignment (persisted + Live Feed)
 *   movement.created  → gate crossing (Live Feed only; carries no coordinates)
 *
 * A 4xx makes their sender retry a few times and then DROP the event, so an
 * unrecognised shape must never fail the request: acknowledge it, log the
 * shape so it can be wired up, and move on. Persistence is idempotent on the
 * provider's own ids, so a retry is harmless.
 */
export async function providerWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { event, items } = unwrapEvent(req.body)
    const kind = (event ?? '').toLowerCase()

    const alerts: RaiFactorySuiteAlert[] = []
    const unmapped: unknown[] = []
    let dispatches = 0
    let movements  = 0
    let sales      = 0

    const wialonNotifications: Parameters<typeof ingestWialonNotifications>[0] = []

    for (const item of items) {
      // Wialon's "Send a request" action posts a `notification` field. It has
      // no event envelope of its own, so the field itself is the marker.
      const wn = wialonNotificationSchema.safeParse(item)
      if (wn.success && (kind.startsWith('wialon') || !kind)) {
        wialonNotifications.push(wn.data)
        continue
      }

      // SALES FIRST, and by SHAPE rather than by name.
      //
      // The provider reuses `dispatch.created` and `movement.created` for the
      // sales lifecycle — it does not mint an event name of its own — so the
      // declared name cannot tell the two apart. Leaving the dispatch branch
      // first was actively wrong: a sales payload parses CLEANLY against the
      // dispatch schema (it carries id/factoryCode/plate/driverName, and
      // `dispatchTime` is merely optional), so it would have been stored as a
      // cane dispatch with the tonnage dropped and a dispatch time invented
      // from the receive clock.
      //
      // The shape is decisive in the other direction too, which is what makes
      // this safe to put first: `tonnage`, `signOutTime` and `returnTime`
      // appear on no other payload the provider sends. A real cane dispatch
      // carries `dispatchTime`/`actualReturnTime` and none of these three, and
      // a movement carries none of them either — so neither can be captured
      // here by mistake.
      if (looksLikeSale(item)) {
        const sl = raiFactorySuiteSaleSchema.safeParse(item)
        if (sl.success) { if (await handleSale(sl.data)) sales++; continue }
      }

      // Prefer the declared event name; fall back to shape-sniffing so a
      // renamed event still lands somewhere sensible.
      if (kind.startsWith('dispatch')) {
        const d = raiFactorySuiteDispatchSchema.safeParse(item)
        if (d.success) { if (await handleDispatch(d.data)) dispatches++; continue }
      }
      if (kind.startsWith('movement')) {
        const m = raiFactorySuiteMovementSchema.safeParse(item)
        if (m.success) { if (await handleMovement(m.data)) movements++; continue }
      }

      const a = raiFactorySuiteAlertSchema.safeParse(item)
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
    if (result || dispatches || movements || sales || wialon) {
      logger.info(
        { event, dispatches, movements, sales, wialon, ...(result ?? {}) },
        'Provider webhook processed',
      )
    }

    sendSuccess(res, {
      event,
      received: items.length,
      alerts:   alerts.length,
      dispatches,
      movements,
      sales,
      wialonNotifications: wialon?.created ?? 0,
      ignored:  unmapped.length,
      ...(result ?? {}),
    })
  } catch (err) {
    next(err)
  }
}
