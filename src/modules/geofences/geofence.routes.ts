import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requireAnyPermission, requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createGeofenceSchema, updateGeofenceSchema, geofenceListQuerySchema, assignVehicleSchema } from './geofence.schema.js'
import * as ctrl from './geofence.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('geofence:read'),              validateQuery(geofenceListQuerySchema), ctrl.list)
router.post('/', requirePermission('geofence:create'),             validateBody(createGeofenceSchema),     ctrl.create)
// MUST precede '/:geofenceId' — otherwise "geojson" is read as a fence id and
// the map layer 404s.
// The map draws fences from this too, for anyone holding one of its two
// Geofences switches (map:geofences, map:custom_geos) without geofence:read.
router.get('/geojson', requireAnyPermission(['geofence:read', 'map:geofences', 'map:custom_geos']), ctrl.geojson)
router.get('/:geofenceId', requirePermission('geofence:read'),   ctrl.getOne)
router.patch('/:geofenceId', requirePermission('geofence:update'), validateBody(updateGeofenceSchema),    ctrl.update)
router.delete('/:geofenceId', requirePermission('geofence:delete'), ctrl.remove)

router.get('/:geofenceId/vehicles', requirePermission('geofence:read'),                ctrl.listVehicles)
router.post('/:geofenceId/vehicles', requirePermission('geofence:update'),               validateBody(assignVehicleSchema), ctrl.assignVehicle)
router.delete('/:geofenceId/vehicles/:vehicleId', requirePermission('geofence:update'),  ctrl.unassignVehicle)

router.get('/:geofenceId/violations', requirePermission('geofence:read'), ctrl.listViolations)

export default router
