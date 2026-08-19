import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import { createFillingSchema, listFillingQuerySchema, createTheftSchema, listTheftQuerySchema } from './fuel.schema.js'
import * as ctrl from './fuel.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/fillings', validateQuery(listFillingQuerySchema), ctrl.listFillings)
router.get('/fillings/:fillingId', ctrl.getFilling)
router.post('/fillings', ingestLimiter, validateBody(createFillingSchema), ctrl.createFilling)

// Whole-fleet, no pagination: the FSL table draws every vehicle at once.
router.get('/tank-state', ctrl.listTankState)

// Whole-fleet probe and sensor health. Unpaginated for the same reason as
// tank-state, and cached in the service — see probe-report.service.
router.get('/probe-health', ctrl.listProbeHealth)

router.get('/thefts', validateQuery(listTheftQuerySchema), ctrl.listThefts)
router.get('/thefts/:theftId', ctrl.getTheft)
router.post('/thefts', ingestLimiter, validateBody(createTheftSchema), ctrl.createTheft)

export default router
