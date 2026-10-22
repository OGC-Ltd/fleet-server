import { Router, type RequestHandler } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { sendSuccess } from '../../core/response/response.js'
import { getVehicleCamera } from './camera.service.js'

const camera: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getVehicleCamera(req.params['orgId'] as string, req.params['vehicleId'] as string))
  } catch (err) { next(err) }
}

const router = Router({ mergeParams: true })

// The unit's dashcam: device, channels, online state and the media server the
// dashboard's player streams from (camera.service). Not cached: the online
// state is read from VSS on every open.
router.get('/vehicles/:vehicleId/camera',
  authenticate, requireOrgAccess, requirePermission('vehicle:read'), requireVehicleInScope,
  (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() },
  camera)

export default router
