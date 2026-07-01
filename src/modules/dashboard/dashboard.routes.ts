import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import * as ctrl from './dashboard.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/summary', ctrl.getSummary)
router.get('/weather', ctrl.getWeather)

export default router
