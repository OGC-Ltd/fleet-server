import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import { createTripSchema, listTripQuerySchema } from './trip.schema.js'
import * as ctrl from './trip.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', validateQuery(listTripQuerySchema), ctrl.list)
router.get('/:tripId', ctrl.getOne)
router.post('/', ingestLimiter, validateBody(createTripSchema), ctrl.create)

export default router
