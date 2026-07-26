import type { Request, Response, NextFunction } from 'express'
import { logger } from '../../lib/logger.js'
import { sendSuccess } from '../../core/response/response.js'
import { ingestAlerts, type ControltechAlert } from './controltech-alerts.service.js'
import { controltechAlertSchema, unwrapEvent } from './webhooks.schema.js'

/**
 * POST /webhook/rai
 *
 * Controltech posts several event types here (alert.created, dispatch.created,
 * movement.created, …). Only alerts currently map to something we render, but
 * a 4xx makes their sender retry a few times and then DROP the event, so an
 * unrecognised shape must never fail the request: acknowledge it, log the
 * shape so it can be wired up, and move on.
 *
 * Acknowledge fast — persistence is idempotent on the provider's own id, so a
 * retry is harmless, but there's no reason to provoke one.
 */
export async function controltechAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const { event, items } = unwrapEvent(req.body)

    // Alerts are the events we can render today.
    const alerts: ControltechAlert[] = []
    const unmapped: unknown[] = []
    for (const item of items) {
      const parsed = controltechAlertSchema.safeParse(item)
      if (parsed.success) alerts.push(parsed.data)
      else unmapped.push(item)
    }

    const result = alerts.length > 0 ? await ingestAlerts(alerts, 'webhook') : null

    if (unmapped.length > 0) {
      // Log the full shape (operational data, no credentials) so the event can
      // be mapped properly rather than guessed at.
      logger.info(
        { event, count: unmapped.length, sample: unmapped[0], keys: Object.keys((unmapped[0] ?? {}) as object) },
        'Webhook event received that we do not map yet',
      )
    }
    if (result) logger.info({ event, ...result }, 'Controltech alert webhook processed')

    sendSuccess(res, {
      event,
      received:  items.length,
      processed: alerts.length,
      ignored:   unmapped.length,
      ...(result ?? {}),
    })
  } catch (err) {
    next(err)
  }
}
