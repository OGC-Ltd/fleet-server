import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateQuery } from '../../middleware/validate.js'
import { telemetryListQuerySchema, trackQuerySchema } from './telemetry.schema.js'
import * as ctrl from './telemetry.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

// Must be declared before /:vehicleId routes to avoid 'snapshot' being treated as a vehicleId
router.get('/vehicles/snapshot', ctrl.getFleetSnapshotHandler)
router.get('/alerts/active',  ctrl.getActiveAlertsHandler)
router.get('/alerts/history', ctrl.getAlertHistoryHandler)
router.get('/maintenance/history', ctrl.getMaintenanceHistoryHandler)

router.get('/vehicles/:vehicleId/telemetry', validateQuery(telemetryListQuerySchema), ctrl.getTelemetryHistory)
router.get('/vehicles/:vehicleId/telemetry/latest', ctrl.getLatestTelemetry)
// Breadcrumb polyline for the map: 3 columns over a window, thinned server-side.
router.get('/vehicles/:vehicleId/track', validateQuery(trackQuerySchema), ctrl.getVehicleTrackHandler)
router.get('/vehicles/:vehicleId/live', ctrl.liveVehicleFeed)
router.get('/vehicles/:vehicleId/maintenance/services', ctrl.getVehicleServiceHistoryHandler)
router.get('/vehicles/:vehicleId/maintenance/garage-visits', ctrl.getVehicleGarageVisitsHandler)

export default router
