import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createUserSchema, updateUserSchema, listUserQuerySchema, assignRoleSchema, orgProvisionUserSchema, setMembershipSchema } from './user.schema.js'
import * as ctrl from './user.controller.js'

// Mounted at /api/v1/organisations/:orgId/users
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('user:read'), validateQuery(listUserQuerySchema), ctrl.list)
router.post('/', requirePermission('user:create'), validateBody(createUserSchema), ctrl.create)
// BEFORE the /:userId routes — a literal path must be declared ahead of the
// parameter that would otherwise swallow it, the same ordering constraint
// app.ts documents for telemetry vs vehicles.
//
// Creates a person AND grants them this organisation in one call, unlike
// POST '/' above, which records someone (a synced driver, say) with no way in.
router.post('/provision', requirePermission('user:create'), validateBody(orgProvisionUserSchema), ctrl.provisionInOrg)

router.get('/:userId', requirePermission('user:read'), ctrl.getOne)

// Which organisations this person may reach, and how much of each fleet.
// Scoped to the path organisation: an admin here cannot read or alter what the
// same person holds anywhere else.
router.get('/:userId/memberships', requirePermission('user:read'), ctrl.listUserMemberships)
router.put('/:userId/memberships', requirePermission('user:assign_role'), validateBody(setMembershipSchema), ctrl.putMembership)
router.delete('/:userId/memberships', requirePermission('user:assign_role'), ctrl.deleteMembership)
router.patch('/:userId', requirePermission('user:update'), validateBody(updateUserSchema), ctrl.update)
router.delete('/:userId', requirePermission('user:delete'), ctrl.remove)

router.post('/:userId/roles', requirePermission('user:assign_role'), validateBody(assignRoleSchema), ctrl.assignRole)
router.delete('/:userId/roles/:roleId', requirePermission('user:assign_role'), ctrl.revokeRole)


export default router
