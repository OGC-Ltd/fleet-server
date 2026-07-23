import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateQuery } from '../../middleware/validate.js'
import { analyticsRangeSchema, speedingQuerySchema, deliveriesQuerySchema } from './analytics.schema.js'
import * as ctrl from './analytics.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/overview',             ctrl.overview)
router.get('/deliveries',           validateQuery(deliveriesQuerySchema), ctrl.deliveries)
router.get('/drivers',              ctrl.driversList)
// Batched roster + per-driver details in one response — must be registered
// before the :driverId route or "overview" would be parsed as a driver id.
router.get('/drivers/overview',     validateQuery(deliveriesQuerySchema), ctrl.driversOverview)
router.get('/drivers/:driverId',    validateQuery(deliveriesQuerySchema), ctrl.driverAnalytics)
router.get('/fuel-efficiency',      validateQuery(analyticsRangeSchema), ctrl.fuelEfficiency)
router.get('/speeding',             validateQuery(speedingQuerySchema),   ctrl.speeding)
router.get('/violation-heatmap',    validateQuery(analyticsRangeSchema), ctrl.violationHeatmap)

export default router
