import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createRoleSchema, updateRoleSchema, permissionAssignSchema, listQuerySchema } from './role.schema.js'
import * as ctrl from './role.controller.js'

// Mounted at /api/v1/organisations/:orgId/roles
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', validateQuery(listQuerySchema), ctrl.list)
router.post('/', validateBody(createRoleSchema), ctrl.create)
router.get('/:roleId', ctrl.getOne)
router.patch('/:roleId', validateBody(updateRoleSchema), ctrl.update)
router.delete('/:roleId', ctrl.remove)

router.post('/:roleId/permissions', validateBody(permissionAssignSchema), ctrl.addPermission)
router.delete('/:roleId/permissions/:permissionId', ctrl.removePermission)

export default router
