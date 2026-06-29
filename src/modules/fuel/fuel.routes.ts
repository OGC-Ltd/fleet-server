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

router.get('/thefts', validateQuery(listTheftQuerySchema), ctrl.listThefts)
router.get('/thefts/:theftId', ctrl.getTheft)
router.post('/thefts', ingestLimiter, validateBody(createTheftSchema), ctrl.createTheft)

export default router
