import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createGroupSchema, updateGroupSchema, createVehicleSchema, updateVehicleSchema, createAssignmentSchema, listQuerySchema } from './vehicle.schema.js'
import * as ctrl from './vehicle.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

// Vehicle groups
router.get('/vehicle-groups', requirePermission('vehicle:read'), ctrl.listGroups)
router.post('/vehicle-groups', requirePermission('vehicle:create'), validateBody(createGroupSchema), ctrl.createGroup)
router.patch('/vehicle-groups/:groupId', requirePermission('vehicle:update'), validateBody(updateGroupSchema), ctrl.updateGroup)

// Vehicles
router.get('/vehicles', requirePermission('vehicle:read'), validateQuery(listQuerySchema), ctrl.list)
router.post('/vehicles', requirePermission('vehicle:create'), validateBody(createVehicleSchema), ctrl.create)
router.get('/vehicles/:vehicleId', requirePermission('vehicle:read'), requireVehicleInScope, ctrl.getOne)
// Operator brief — 2-3 sentences on what this unit has done today. Generated
// on demand (see vehicle-brief) rather than warmed, because a 597-vehicle
// fleet cannot have every unit's narrative regenerated on a timer.
router.get('/vehicles/:vehicleId/brief', requirePermission('vehicle:read'), requireVehicleInScope, ctrl.getBrief)
// The unit's insight — findings, memory and one action — written in the
// background (see vehicle-insight) and read here instantly on a click.
router.get('/vehicles/:vehicleId/insight', requirePermission('vehicle:read'), requireVehicleInScope, ctrl.getInsight)
router.patch('/vehicles/:vehicleId', requirePermission('vehicle:update'), requireVehicleInScope, validateBody(updateVehicleSchema), ctrl.update)
router.delete('/vehicles/:vehicleId', requirePermission('vehicle:delete'), requireVehicleInScope, ctrl.remove)

// Assignments
router.get('/vehicles/:vehicleId/assignments', requirePermission('assignment:read'), requireVehicleInScope, ctrl.listAssignments)
router.post('/vehicles/:vehicleId/assignments', requirePermission('assignment:create'), requireVehicleInScope, validateBody(createAssignmentSchema), ctrl.createAssignment)
router.delete('/vehicles/:vehicleId/assignments/:assignmentId', requirePermission('assignment:delete'), requireVehicleInScope, ctrl.endAssignment)

export default router
