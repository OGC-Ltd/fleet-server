import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { daySaveSchema, dayBeforeQuerySchema, orderSaveSchema } from './deliveries.schema.js'
import * as ctrl from './deliveries.controller.js'

// The Deliveries report's day list and typed orders (operator, 2026-11-11),
// kept on the server instead of each browser. See deliveries.service.
// telemetry:read is what opens the Deliveries tab (new-ui lib/reportNav), so the
// same people who could edit the list in their browser can edit it here.
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess, requirePermission('telemetry:read'))

router.get('/days',         validateQuery(dayBeforeQuerySchema), ctrl.lastDayBefore)
router.get('/days/:day',    ctrl.getDay)
router.put('/days/:day',    validateBody(daySaveSchema), ctrl.saveDay)
router.get('/orders',       ctrl.getOrders)
router.put('/orders/:plate', validateBody(orderSaveSchema), ctrl.saveOrder)

export default router
