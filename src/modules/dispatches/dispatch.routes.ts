import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireAnyPermission } from '../../middleware/authorize.js'
import { validateQuery } from '../../middleware/validate.js'
import * as ctrl from './dispatch.controller.js'
import { runsQuerySchema } from './dispatch-runs.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/active', requirePermission('dispatch:read'), ctrl.listActive)
// The reports name each incident's driver from these, so a role that runs
// reports but does not see the dispatch board can still read them.
router.get('/runs', requireAnyPermission(['dispatch:read', 'report:read']), validateQuery(runsQuerySchema), ctrl.listRuns)

export default router
