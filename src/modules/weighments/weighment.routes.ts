import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateQuery } from '../../middleware/validate.js'
import { weighmentQuerySchema } from './weighment.schema.js'
import * as ctrl from './weighment.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

// `weighbridge:read` already existed in the permission table — the page it was
// written for is this one.
router.get('/', requirePermission('weighbridge:read'), validateQuery(weighmentQuerySchema), ctrl.listDay)

export default router
