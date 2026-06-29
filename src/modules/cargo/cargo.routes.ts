import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody } from '../../middleware/validate.js'
import { upsertCargoSchema } from './cargo.schema.js'
import * as ctrl from './cargo.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/:tripId/cargo',    ctrl.getManifest)
router.put('/:tripId/cargo',    validateBody(upsertCargoSchema), ctrl.upsertManifest)
router.delete('/:tripId/cargo', ctrl.deleteManifest)

export default router
