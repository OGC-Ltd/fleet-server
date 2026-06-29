import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateQuery } from '../../middleware/validate.js'
import { analyticsRangeSchema, speedingQuerySchema } from './analytics.schema.js'
import * as ctrl from './analytics.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/overview',             ctrl.overview)
router.get('/fuel-efficiency',      validateQuery(analyticsRangeSchema), ctrl.fuelEfficiency)
router.get('/speeding',             validateQuery(speedingQuerySchema),   ctrl.speeding)
router.get('/violation-heatmap',    validateQuery(analyticsRangeSchema), ctrl.violationHeatmap)

export default router
