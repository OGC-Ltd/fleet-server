import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { previewSheetSchema, saveSheetSchema, planListQuerySchema, stopUpdateSchema, customerListQuerySchema, customerFenceSchema } from './planner.schema.js'
import * as ctrl from './planner.controller.js'

// Planner: delivery sheets per truck and day, their customers' geofences, and
// what happened at each stop (operator, 2026-11-11). See planner.service.
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.post('/sheets/preview', requirePermission('planner:write'), validateBody(previewSheetSchema), ctrl.preview)
router.post('/sheets',         requirePermission('planner:write'), validateBody(saveSheetSchema),    ctrl.save)
router.get('/plans',           requirePermission('planner:read'),  validateQuery(planListQuerySchema), ctrl.list)
router.get('/plans/:planId',   requirePermission('planner:read'),  ctrl.getOne)
router.patch('/plans/:planId/stops/:stopId', requirePermission('planner:write'), validateBody(stopUpdateSchema), ctrl.updateStop)
router.delete('/plans/:planId', requirePermission('planner:write'), ctrl.remove)
router.get('/customers',       requirePermission('planner:read'),  validateQuery(customerListQuerySchema), ctrl.customers)
router.post('/customers/:customerId/fence', requirePermission('planner:write'), requirePermission('geofence:create'), validateBody(customerFenceSchema), ctrl.fenceCustomer)

export default router
