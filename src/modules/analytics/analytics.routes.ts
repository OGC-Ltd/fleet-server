import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateQuery } from '../../middleware/validate.js'
import { analyticsRangeSchema, speedingQuerySchema, deliveriesQuerySchema, fuelCostQuerySchema, driverScoresQuerySchema } from './analytics.schema.js'
import * as ctrl from './analytics.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/overview', requirePermission('analytics:read'),             ctrl.overview)
router.get('/deliveries', requirePermission('analytics:read'),           validateQuery(deliveriesQuerySchema), ctrl.deliveries)
router.get('/drivers', requirePermission('driver:read'),              ctrl.driversList)
// Batched roster + per-driver details in one response — must be registered
// before the :driverId route or "overview" would be parsed as a driver id.
router.get('/drivers/overview', requirePermission('driver:read'),     validateQuery(deliveriesQuerySchema), ctrl.driversOverview)
// Speed and safety points per driver-day, from the driver pay proposal.
router.get('/driver-scores', requirePermission('driver:read'),        validateQuery(driverScoresQuerySchema), ctrl.driverScores)
router.get('/drivers/:driverId', requirePermission('driver:read'),    validateQuery(deliveriesQuerySchema), ctrl.driverAnalytics)
router.get('/fuel-efficiency', requirePermission('analytics:read'),      validateQuery(analyticsRangeSchema), ctrl.fuelEfficiency)
// Ledger-backed fuel + cost. Distinct from /fuel-efficiency above, which reads
// the telemetry fuelUsedMl channel — empty on this fleet's trackers.
router.get('/fuel-cost', requirePermission('analytics:read'),            validateQuery(fuelCostQuerySchema),  ctrl.fuelCost)
// Today on the ground — local midnight → now. No query params: the window is
// the fleet day, which is not something a caller gets to choose.
router.get('/operations-today', requirePermission('analytics:read'),     ctrl.operationsToday)
// Plant and trucks, on their own telemetry rather than the yard's paperwork.
router.get('/machine-starts', requirePermission('analytics:read'),       ctrl.machineStarts)
router.get('/machine-hours', requirePermission('analytics:read'),        ctrl.machineHours)
router.get('/machine-summary', requirePermission('analytics:read'),      ctrl.machineSummary)
router.get('/fleet-state', requirePermission('analytics:read'),          ctrl.fleetStateHandler)
// The vehicle-type filter's options — what categories this fleet actually has.
// Unfiltered by design: it is the list the filter is chosen FROM.
router.get('/vehicle-categories', requirePermission('analytics:read'),   ctrl.vehicleCategories)
router.get('/excavator-area', requirePermission('analytics:read'),       ctrl.excavatorArea)
router.get('/excavator-area-days', requirePermission('analytics:read'),  ctrl.excavatorAreaByDay)
router.get('/fuel-rate-days', requirePermission('analytics:read'),       ctrl.fuelRateDays)
// One unit's own fuel history. Distinct from /fuel-rate-days, whose floors are
// sized for a whole yard and reject most of a single unit's days.
router.get('/vehicle-fuel-days', requirePermission('analytics:read'),    ctrl.vehicleFuelDays)
router.get('/sugar-hauls', requirePermission('analytics:read'),          ctrl.sugarHauls)
// Where the fleet's units actually stop, and whether a busy stop is one place
// or two. Telemetry-derived, so it needs no dispatch feed and no geofences.
router.get('/stop-clusters', requirePermission('analytics:read'),       ctrl.stopClusters)
router.get('/speeding', requirePermission('analytics:read'),             validateQuery(speedingQuerySchema),   ctrl.speeding)
router.get('/violation-heatmap', requirePermission('analytics:read'),    validateQuery(analyticsRangeSchema), ctrl.violationHeatmap)

export default router
