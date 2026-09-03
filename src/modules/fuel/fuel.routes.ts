import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import { createFillingSchema, listFillingQuerySchema, createTheftSchema, listTheftQuerySchema } from './fuel.schema.js'
import * as ctrl from './fuel.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/fillings', requirePermission('fuel_filling:read'), validateQuery(listFillingQuerySchema), ctrl.listFillings)
router.get('/fillings/:fillingId', requirePermission('fuel_filling:read'), ctrl.getFilling)
router.post('/fillings', requirePermission('fuel_filling:create'), ingestLimiter, validateBody(createFillingSchema), ctrl.createFilling)

// Whole-fleet, no pagination: the FSL table draws every vehicle at once.
router.get('/tank-state', requirePermission('fuel_filling:read'), ctrl.listTankState)

// Whole-fleet probe and sensor health. Unpaginated for the same reason as
// tank-state, and cached in the service — see probe-report.service.
router.get('/probe-health', requirePermission('sensor:read'), ctrl.listProbeHealth)

router.get('/thefts', requirePermission('fuel_theft:read'), validateQuery(listTheftQuerySchema), ctrl.listThefts)
router.get('/thefts/:theftId', requirePermission('fuel_theft:read'), ctrl.getTheft)
router.post('/thefts', requirePermission('fuel_theft:create'), ingestLimiter, validateBody(createTheftSchema), ctrl.createTheft)

export default router
