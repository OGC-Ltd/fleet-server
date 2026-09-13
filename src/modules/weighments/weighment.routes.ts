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

// The scales and their latest ticket, for the map's weighbridge layer. Same
// permission: it is the same data, read a different way round, and an account
// that may not see the grid must not see it one marker at a time either.
//
// Declared BEFORE any '/:something' route would be, so 'bridges' is never
// swallowed as a parameter. There is no such route today; this is where one
// would go, and the ordering is the cheap half of not being bitten by it.
router.get('/bridges', requirePermission('weighbridge:read'), ctrl.listBridges)

export default router
