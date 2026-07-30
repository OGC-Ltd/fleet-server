import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import * as ctrl from './dispatch.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/active', ctrl.listActive)

export default router
