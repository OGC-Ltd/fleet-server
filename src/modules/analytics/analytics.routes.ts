import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateQuery } from '../../middleware/validate.js'
import { analyticsRangeSchema, speedingQuerySchema, deliveriesQuerySchema, fuelCostQuerySchema } from './analytics.schema.js'
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
// Ledger-backed fuel + cost. Distinct from /fuel-efficiency above, which reads
// the telemetry fuelUsedMl channel — empty on this fleet's trackers.
router.get('/fuel-cost',            validateQuery(fuelCostQuerySchema),  ctrl.fuelCost)
// Today on the ground — local midnight → now. No query params: the window is
// the fleet day, which is not something a caller gets to choose.
router.get('/operations-today',     ctrl.operationsToday)
// Plant and trucks, on their own telemetry rather than the yard's paperwork.
router.get('/machine-starts',       ctrl.machineStarts)
router.get('/machine-hours',        ctrl.machineHours)
router.get('/speeding',             validateQuery(speedingQuerySchema),   ctrl.speeding)
router.get('/violation-heatmap',    validateQuery(analyticsRangeSchema), ctrl.violationHeatmap)

export default router
