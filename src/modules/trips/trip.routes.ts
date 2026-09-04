import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import { createTripSchema, listTripQuerySchema } from './trip.schema.js'
import * as ctrl from './trip.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('trip:read'), validateQuery(listTripQuerySchema), ctrl.list)
router.get('/:tripId', requirePermission('trip:read'), ctrl.getOne)
router.post('/', requirePermission('trip:create'), ingestLimiter, validateBody(createTripSchema), ctrl.create)

export default router
