import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import * as ctrl from './notifications.controller.js'

// ─── org-scoped: /api/v1/organisations/:orgId/notifications ───────────────
const orgRouter = Router({ mergeParams: true })
orgRouter.use(authenticate, requireOrgAccess)
orgRouter.get('/',              requirePermission('notification:read'), ctrl.listNotifications)
orgRouter.post('/subscribe',    requirePermission('notification:read'), ctrl.subscribe)
orgRouter.delete('/subscribe',  requirePermission('notification:read'), ctrl.unsubscribe)

export { orgRouter as notificationsOrgRouter }
