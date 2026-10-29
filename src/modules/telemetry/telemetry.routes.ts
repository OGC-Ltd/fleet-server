import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateQuery } from '../../middleware/validate.js'
import { telemetryListQuerySchema, trackQuerySchema, playbackQuerySchema, daySeriesQuerySchema } from './telemetry.schema.js'
import * as ctrl from './telemetry.controller.js'
import { getTripReportHandler } from '../trips/trip-report.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

// Must be declared before /:vehicleId routes to avoid 'snapshot' being treated as a vehicleId
router.get('/vehicles/snapshot', requirePermission('telemetry:read'), ctrl.getFleetSnapshotHandler)
router.get('/alerts/active', requirePermission('notification:read'),  ctrl.getActiveAlertsHandler)
router.get('/alerts/history', requirePermission('notification:read'), ctrl.getAlertHistoryHandler)
router.get('/maintenance/history', requirePermission('vehicle:read'), ctrl.getMaintenanceHistoryHandler)

router.get('/vehicles/:vehicleId/telemetry', requirePermission('telemetry:read'), requireVehicleInScope, validateQuery(telemetryListQuerySchema), ctrl.getTelemetryHistory)
// The vehicle panel's fuel & overspeed chart: one fleet day, chart columns only.
router.get('/vehicles/:vehicleId/telemetry/day', requirePermission('telemetry:read'), requireVehicleInScope, validateQuery(daySeriesQuerySchema), ctrl.getVehicleDaySeriesHandler)
router.get('/vehicles/:vehicleId/telemetry/latest', requirePermission('telemetry:read'), requireVehicleInScope, ctrl.getLatestTelemetry)
// Breadcrumb polyline for the map: 3 columns over a window, thinned server-side.
router.get('/vehicles/:vehicleId/track', requirePermission('telemetry:read'), requireVehicleInScope, validateQuery(trackQuerySchema), ctrl.getVehicleTrackHandler)
router.get('/vehicles/:vehicleId/playback', requirePermission('map:playback'), requireVehicleInScope, validateQuery(playbackQuerySchema), ctrl.getVehiclePlaybackHandler)
// One dispatch's printable trip report: track, fuel, breaches, zones, weighbridge.
router.get('/vehicles/:vehicleId/trip-report', requirePermission('telemetry:read'), requireVehicleInScope, getTripReportHandler)
router.get('/vehicles/:vehicleId/live', requirePermission('telemetry:read'), requireVehicleInScope, ctrl.liveVehicleFeed)
router.get('/vehicles/:vehicleId/maintenance/services', requirePermission('vehicle:read'), requireVehicleInScope, ctrl.getVehicleServiceHistoryHandler)
router.get('/vehicles/:vehicleId/maintenance/garage-visits', requirePermission('vehicle:read'), requireVehicleInScope, ctrl.getVehicleGarageVisitsHandler)

export default router
