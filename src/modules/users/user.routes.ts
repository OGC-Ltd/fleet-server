import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createUserSchema, updateUserSchema, listUserQuerySchema, assignRoleSchema } from './user.schema.js'
import * as ctrl from './user.controller.js'

// Mounted at /api/v1/organisations/:orgId/users
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', validateQuery(listUserQuerySchema), ctrl.list)
router.post('/', validateBody(createUserSchema), ctrl.create)
router.get('/:userId', ctrl.getOne)
router.patch('/:userId', validateBody(updateUserSchema), ctrl.update)
router.delete('/:userId', ctrl.remove)

router.post('/:userId/roles', validateBody(assignRoleSchema), ctrl.assignRole)
router.delete('/:userId/roles/:roleId', ctrl.revokeRole)

export default router
