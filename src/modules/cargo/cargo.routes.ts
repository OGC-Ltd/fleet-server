import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody } from '../../middleware/validate.js'
import { upsertCargoSchema } from './cargo.schema.js'
import * as ctrl from './cargo.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/:tripId/cargo', requirePermission('cargo:read'),    ctrl.getManifest)
router.put('/:tripId/cargo', requirePermission('cargo:update'),    validateBody(upsertCargoSchema), ctrl.upsertManifest)
router.delete('/:tripId/cargo', requirePermission('cargo:delete'), ctrl.deleteManifest)

export default router
