import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createGeofenceSchema, updateGeofenceSchema, geofenceListQuerySchema, assignVehicleSchema } from './geofence.schema.js'
import * as ctrl from './geofence.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/',              validateQuery(geofenceListQuerySchema), ctrl.list)
router.post('/',             validateBody(createGeofenceSchema),     ctrl.create)
// MUST precede '/:geofenceId' — otherwise "geojson" is read as a fence id and
// the map layer 404s.
router.get('/geojson',       ctrl.geojson)
router.get('/:geofenceId',   ctrl.getOne)
router.patch('/:geofenceId', validateBody(updateGeofenceSchema),    ctrl.update)
router.delete('/:geofenceId', ctrl.remove)

router.get('/:geofenceId/vehicles',                ctrl.listVehicles)
router.post('/:geofenceId/vehicles',               validateBody(assignVehicleSchema), ctrl.assignVehicle)
router.delete('/:geofenceId/vehicles/:vehicleId',  ctrl.unassignVehicle)

router.get('/:geofenceId/violations', ctrl.listViolations)

export default router
