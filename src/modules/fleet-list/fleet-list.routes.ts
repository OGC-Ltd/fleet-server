import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody } from '../../middleware/validate.js'
import { saveFleetListSchema } from './fleet-list.schema.js'
import * as ctrl from './fleet-list.controller.js'

// The client's fleet list, one for the organisation (fleet-list.service).
// Read by the reports that show drivers and statuses (Probe & Sensor Health)
// and TYPE targets (Fuel Consumption Rate, Fuel Graphs); changed by those who
// may amend vehicles. The uploaded file itself (S3) is downloadable only by
// those who may change the list: it carries ID and phone numbers the page never
// reads.
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/',       requirePermission('telemetry:read'), ctrl.get)
router.post('/',      requirePermission('vehicle:update'), validateBody(saveFleetListSchema), ctrl.save)
router.post('/reset', requirePermission('vehicle:update'), ctrl.reset)
router.get('/:id/file', requirePermission('vehicle:update'), ctrl.file)

export default router
