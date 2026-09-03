import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createRoleSchema, updateRoleSchema, permissionAssignSchema, listQuerySchema } from './role.schema.js'
import * as ctrl from './role.controller.js'

// Mounted at /api/v1/organisations/:orgId/roles
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('role:read'), validateQuery(listQuerySchema), ctrl.list)
router.post('/', requirePermission('role:create'), validateBody(createRoleSchema), ctrl.create)
router.get('/:roleId', requirePermission('role:read'), ctrl.getOne)
router.patch('/:roleId', requirePermission('role:update'), validateBody(updateRoleSchema), ctrl.update)
router.delete('/:roleId', requirePermission('role:delete'), ctrl.remove)

router.post('/:roleId/permissions', requirePermission('role:update'), validateBody(permissionAssignSchema), ctrl.addPermission)
router.delete('/:roleId/permissions/:permissionId', requirePermission('role:update'), ctrl.removePermission)

export default router
