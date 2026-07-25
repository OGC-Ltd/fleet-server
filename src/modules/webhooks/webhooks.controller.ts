import type { Request, Response, NextFunction } from 'express'
import { logger } from '../../lib/logger.js'
import { sendSuccess } from '../../core/response/response.js'
import { ingestAlerts } from './controltech-alerts.service.js'
import { toAlertArray, type ControltechAlertPayload } from './webhooks.schema.js'

/**
 * POST /api/v1/webhooks/controltech/alerts
 *
 * Acknowledge fast and unconditionally once the payload is valid: a webhook
 * sender retries on non-2xx, and a slow or failing ACK makes it redeliver the
 * same alerts. Persistence is idempotent on the provider's alert id, so a
 * retry is harmless — but there's no reason to provoke one.
 */
export async function controltechAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const alerts = toAlertArray(req.body as ControltechAlertPayload)
    const result = await ingestAlerts(alerts, 'webhook')

    logger.info(
      { received: alerts.length, ...result },
      'Controltech alert webhook processed',
    )
    sendSuccess(res, { received: alerts.length, ...result })
  } catch (err) {
    next(err)
  }
}
