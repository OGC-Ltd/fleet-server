import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createOrgSchema, updateOrgSchema, listOrgQuerySchema } from './organisation.schema.js'
import * as ctrl from './organisation.controller.js'

const router = Router()

// This router has NO :orgId, so requireOrgAccess cannot guard it - and used to
// fail open when the param was absent. Every route below is therefore PLATFORM
// surface: requirePermission admits only a platform role here, which is what
// stops an ordinary member of one tenant listing, reading, creating and
// PATCHing every other tenant.
router.use(authenticate)

router.get('/', requirePermission('organisation:read'), validateQuery(listOrgQuerySchema), ctrl.list)
router.post('/', requirePermission('organisation:create'), validateBody(createOrgSchema), ctrl.create)
router.get('/:id', requirePermission('organisation:read'), ctrl.getOne)
router.patch('/:id', requirePermission('organisation:update'), validateBody(updateOrgSchema), ctrl.update)

export default router
