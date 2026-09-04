import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import * as ctrl from './dashboard.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/summary', requirePermission('dashboard:read'),    ctrl.getSummary)
router.get('/weather', requirePermission('dashboard:read'),    ctrl.getWeather)
router.get('/ai-insight', requirePermission('dashboard:read'), ctrl.getAiInsightHandler)

export default router
