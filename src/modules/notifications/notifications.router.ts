import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import * as ctrl from './notifications.controller.js'

// ─── org-scoped: /api/v1/organisations/:orgId/notifications ───────────────
const orgRouter = Router({ mergeParams: true })
orgRouter.use(authenticate, requireOrgAccess)
orgRouter.post('/subscribe',    ctrl.subscribe)
orgRouter.delete('/subscribe',  ctrl.unsubscribe)

export { orgRouter as notificationsOrgRouter }
