import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { previewSheetSchema, saveSheetSchema, planListQuerySchema, stopUpdateSchema, customerListQuerySchema, customerFenceSchema, workPlansQuerySchema, factoryFuelQuerySchema, factoryFuelRefillsQuerySchema } from './planner.schema.js'
import * as ctrl from './planner.controller.js'

// Planner: delivery sheets per truck and day, their customers' geofences, and
// what happened at each stop (operator, 2026-11-11). See planner.service.
const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.post('/sheets/preview', requirePermission('planner:write'), validateBody(previewSheetSchema), ctrl.preview)
router.post('/sheets',         requirePermission('planner:write'), validateBody(saveSheetSchema),    ctrl.save)
router.get('/plans',           requirePermission('planner:read'),  validateQuery(planListQuerySchema), ctrl.list)
router.get('/plans/:planId',   requirePermission('planner:read'),  ctrl.getOne)
router.patch('/plans/:planId/stops/:stopId', requirePermission('planner:write'), validateBody(stopUpdateSchema), ctrl.updateStop)
router.delete('/plans/:planId', requirePermission('planner:write'), ctrl.remove)
router.get('/customers',       requirePermission('planner:read'),  validateQuery(customerListQuerySchema), ctrl.customers)
router.post('/customers/:customerId/fence', requirePermission('planner:write'), requirePermission('geofence:create'), validateBody(customerFenceSchema), ctrl.fenceCustomer)

// FactorySuite work plans on the Live Map: a map layer, so the map's right
// rather than the Planner's (the switch sits beside Geofences on the rail).
router.get('/work-plans',      requirePermission('map:read'),      validateQuery(workPlansQuerySchema), ctrl.workPlans)

// The Fuel page: FactorySuite's plans, fuel requests and pump issues. A fuel
// screen, so the fuel fillings' right.
router.get('/factory-fuel',    requirePermission('fuel_filling:read'), validateQuery(factoryFuelQuerySchema), ctrl.factoryFuel)
// Its Consumed column: each probed machine's tank day by day (tank-days.ts)
router.get('/factory-fuel/tank-days', requirePermission('fuel_filling:read'), validateQuery(factoryFuelQuerySchema), ctrl.tankDays)
// Its refills: the tracker's meter either side of each fuelling (the table),
// and for one machine the fuel burned in the shift it was for (fuel-refills.ts)
router.get('/factory-fuel/refills', requirePermission('fuel_filling:read'), validateQuery(factoryFuelRefillsQuerySchema), ctrl.factoryFuelRefills)

// The Drivers page's Operators tab: who the work plans put on each machine. A
// people screen, so the drivers' right.
router.get('/factory-operators', requirePermission('driver:read'), validateQuery(factoryFuelQuerySchema), ctrl.factoryOperators)
router.get('/factory-supervisors', requirePermission('driver:read'), validateQuery(factoryFuelQuerySchema), ctrl.factorySupervisors)
// Work plan items that changed on days from..to (planner/work-plan-watch).
router.get('/work-plan-updates', requirePermission('fuel_filling:read'), validateQuery(factoryFuelQuerySchema), ctrl.workPlanUpdates)

export default router
