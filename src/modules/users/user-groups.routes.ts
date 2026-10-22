import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermissionStrict } from '../../middleware/authorize.js'
import { requireRealAuth } from '../../middleware/requireRealAuth.js'
import { validateBody } from '../../middleware/validate.js'
import * as ctrl from './user-groups.controller.js'
import {
  createUserGroupSchema,
  setUserGroupsSchema,
  updateUserGroupSchema,
} from './user-groups.schema.js'

const router = Router({ mergeParams: true })

router.use(authenticate)
router.use((req, res, next) => req.params['orgId']
  ? requireOrgAccess(req, res, next)
  : next())
router.get('/', requirePermissionStrict('user:read'), ctrl.list)
router.post('/', requireRealAuth, requirePermissionStrict('user:assign_role'), validateBody(createUserGroupSchema), ctrl.create)

// The literal /users path must be declared before /:groupId.
router.put('/users/:userId', requireRealAuth, requirePermissionStrict('user:assign_role'), validateBody(setUserGroupsSchema), ctrl.setUserGroups)
router.put('/:groupId/users/:userId', requireRealAuth, requirePermissionStrict('user:assign_role'), ctrl.addUser)
router.delete('/:groupId/users/:userId', requireRealAuth, requirePermissionStrict('user:assign_role'), ctrl.removeUser)
router.patch('/:groupId', requireRealAuth, requirePermissionStrict('user:assign_role'), validateBody(updateUserGroupSchema), ctrl.update)
router.delete('/:groupId', requireRealAuth, requirePermissionStrict('user:assign_role'), ctrl.remove)

export default router
