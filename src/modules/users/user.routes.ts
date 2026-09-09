import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requirePermissionStrict } from '../../middleware/authorize.js'
import { requireRealAuth } from '../../middleware/requireRealAuth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createUserSchema, updateUserSchema, listUserQuerySchema, assignRoleSchema, orgProvisionUserSchema, setMembershipSchema, setUserStatusSchema, setUserRoleSchema } from './user.schema.js'
import * as ctrl from './user.controller.js'

// Mounted at /api/v1/organisations/:orgId/users
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

// ── Who may see and administer people ───────────────────────────────────────
//
// STRICT, all of them. An administrator sees the people in the organisations
// they were added to — all of those, and only those — and `requireOrgAccess`
// alone cannot deliver that half of it: it runs in shadow mode while
// AUTHZ_ENFORCE is false, so it logs "WOULD DENY" and lets the request
// through. An admin at one site could read and edit another site's roster by
// changing the id in the URL.
//
// requirePermissionStrict performs canReachOrg AND the permission check
// itself, and always throws. That is what makes the scope real rather than
// observed. Reaching several organisations still works exactly as before —
// each is checked on its own request, so an admin added to A and B passes for
// both and for nothing else.
//
// The blast radius is contained: dash reaches these routes from one component
// (the User Accounts panel via api/users.js), so no screen that works today
// starts failing. What stops working is the thing that should never have
// worked.
router.get('/', requirePermissionStrict('user:read'), validateQuery(listUserQuerySchema), ctrl.list)
router.post('/', requireRealAuth, requirePermissionStrict('user:create'), validateBody(createUserSchema), ctrl.create)
// BEFORE the /:userId routes — a literal path must be declared ahead of the
// parameter that would otherwise swallow it, the same ordering constraint
// app.ts documents for telemetry vs vehicles.
//
// Creates a person AND grants them this organisation in one call, unlike
// POST '/' above, which records someone (a synced driver, say) with no way in.
//
// requirePermissionStrict, not requirePermission: this route did not exist
// yesterday, so it has no legacy traffic for shadow mode to observe and no
// mapping to discover. Shipping account creation in a mode that logs
// "WOULD DENY" and then creates the user anyway would be shipping an open door
// with a diary attached.
router.post('/provision', requireRealAuth, requirePermissionStrict('user:create'), validateBody(orgProvisionUserSchema), ctrl.provisionInOrg)

// Also before /:userId — a literal must beat the parameter that would swallow it.
router.get('/assignable-roles', requirePermissionStrict('user:assign_role'), ctrl.listAssignableRoles)

router.get('/:userId', requirePermissionStrict('user:read'), ctrl.getOne)

// Which organisations this person may reach, and how much of each fleet.
// Scoped to the path organisation: an admin here cannot read or alter what the
// same person holds anywhere else.
//
// The two writes are STRICT, unlike most of this file. They are what the
// administration page's edit form calls to add an organisation, take one away,
// or change the roles held in it — so under shadow mode a caller without
// user:assign_role would have the change logged as "WOULD DENY" and then
// applied. requireRealAuth for the same reason it guards the routes below: an
// AUTH_BYPASS deployment must not hand out memberships to an unauthenticated
// caller. The GET stays as it was; reading who has access is already gated by
// user:read and org reach.
router.get('/:userId/memberships', requirePermissionStrict('user:read'), ctrl.listUserMemberships)
router.put('/:userId/memberships', requireRealAuth, requirePermissionStrict('user:assign_role'), validateBody(setMembershipSchema), ctrl.putMembership)
router.delete('/:userId/memberships', requireRealAuth, requirePermissionStrict('user:assign_role'), ctrl.deleteMembership)
router.patch('/:userId', requireRealAuth, requirePermissionStrict('user:update'), validateBody(updateUserSchema), ctrl.update)
router.delete('/:userId', requireRealAuth, requirePermissionStrict('user:delete'), ctrl.remove)
// Permanent, and therefore its own path rather than a flag on the one above.
//
// A query parameter that turns a reversible delete into an irreversible one is
// a foot-gun in every client that ever forwards a request: `?hard=true` typoed
// into a script, or carried along by a proxy, destroys an account through an
// endpoint whose name says it only marks one. A distinct URL cannot be reached
// by accident, and it reads as what it is in an access log.
//
// Same permission as the soft delete on purpose. `user:delete` already means
// "may remove people"; a second permission would have to be granted to
// somebody, and the roles that hold user:delete are the two administrator
// roles, which is exactly the audience. The protection that matters is in the
// service — self, guests, and anybody with operations history are refused —
// and in the client, which asks for the address to be typed out.
router.delete('/:userId/permanent', requireRealAuth, requirePermissionStrict('user:delete'), ctrl.purge)

// ── Administration of an existing person, all strictly gated ────────────────
router.post('/:userId/resend-invite', requireRealAuth, requirePermissionStrict('user:create'), ctrl.resendInvite)
router.patch('/:userId/status', requireRealAuth, requirePermissionStrict('user:update'), validateBody(setUserStatusSchema), ctrl.setUserStatus)
router.patch('/:userId/role', requireRealAuth, requirePermissionStrict('user:assign_role'), validateBody(setUserRoleSchema), ctrl.setUserRole)

router.post('/:userId/roles', requireRealAuth, requirePermissionStrict('user:assign_role'), validateBody(assignRoleSchema), ctrl.assignRole)
router.delete('/:userId/roles/:roleId', requireRealAuth, requirePermissionStrict('user:assign_role'), ctrl.revokeRole)


export default router
