import { Router } from 'express'
import { webhookAuth } from '../../middleware/webhookAuth.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import { validateBody } from '../../middleware/validate.js'
import { webhookEnvelopeSchema } from './webhooks.schema.js'
import { providerWebhook } from './webhooks.controller.js'

const router = Router()

// Provider push endpoint — replaces polling /alerts. Rate-limited with the
// ingest budget (webhooks burst like device traffic, not user traffic).
//
// Mounted at the ROOT as POST /webhook/rai (not under /api/v1) — this is the
// callback URL registered with RaiFactorySuite.
router.post(
  '/rai',
  ingestLimiter,
  webhookAuth,
  // Deliberately permissive: the controller sorts the event types out. A 400
  // here would make the provider retry and then drop the event.
  validateBody(webhookEnvelopeSchema),
  providerWebhook,
)

export default router
