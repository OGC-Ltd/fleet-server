import { Router } from 'express'
import { webhookAuth } from '../../middleware/webhookAuth.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import { validateBody } from '../../middleware/validate.js'
import { controltechAlertPayloadSchema } from './webhooks.schema.js'
import { controltechAlerts } from './webhooks.controller.js'

const router = Router()

// Provider push endpoint — replaces polling /alerts. Rate-limited with the
// ingest budget (webhooks burst like device traffic, not user traffic).
//
// Mounted at the ROOT as POST /webhook/rai (not under /api/v1) — this is the
// callback URL registered with Controltech.
router.post(
  '/rai',
  ingestLimiter,
  webhookAuth,
  validateBody(controltechAlertPayloadSchema),
  controltechAlerts,
)

export default router
