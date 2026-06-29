import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createGroupSchema, updateGroupSchema, createVehicleSchema, updateVehicleSchema, createAssignmentSchema, listQuerySchema } from './vehicle.schema.js'
import * as ctrl from './vehicle.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

// Vehicle groups
router.get('/vehicle-groups', ctrl.listGroups)
router.post('/vehicle-groups', validateBody(createGroupSchema), ctrl.createGroup)
router.patch('/vehicle-groups/:groupId', validateBody(updateGroupSchema), ctrl.updateGroup)

// Vehicles
router.get('/vehicles', validateQuery(listQuerySchema), ctrl.list)
router.post('/vehicles', validateBody(createVehicleSchema), ctrl.create)
router.get('/vehicles/:vehicleId', ctrl.getOne)
router.patch('/vehicles/:vehicleId', validateBody(updateVehicleSchema), ctrl.update)
router.delete('/vehicles/:vehicleId', ctrl.remove)

// Assignments
router.get('/vehicles/:vehicleId/assignments', ctrl.listAssignments)
router.post('/vehicles/:vehicleId/assignments', validateBody(createAssignmentSchema), ctrl.createAssignment)
router.delete('/vehicles/:vehicleId/assignments/:assignmentId', ctrl.endAssignment)

export default router
