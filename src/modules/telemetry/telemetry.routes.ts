import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateQuery } from '../../middleware/validate.js'
import { telemetryListQuerySchema } from './telemetry.schema.js'
import * as ctrl from './telemetry.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/vehicles/:vehicleId/telemetry', validateQuery(telemetryListQuerySchema), ctrl.getTelemetryHistory)
router.get('/vehicles/:vehicleId/telemetry/latest', ctrl.getLatestTelemetry)
router.get('/vehicles/:vehicleId/live', ctrl.liveVehicleFeed)

export default router
