import { Router } from 'express'
import { ingestAuth } from '../../middleware/ingestAuth.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import { validateBody } from '../../middleware/validate.js'
import { telemetryPayloadSchema } from './ingest.schema.js'
import { ingest } from './ingest.controller.js'

const router = Router()

router.post('/telemetry', ingestLimiter, ingestAuth, validateBody(telemetryPayloadSchema), ingest)

export default router
