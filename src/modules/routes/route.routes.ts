import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createRouteSchema, updateRouteSchema, routeListQuerySchema } from './route.schema.js'
import * as ctrl from './route.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('route:read'),         validateQuery(routeListQuerySchema), ctrl.list)
router.post('/', requirePermission('route:create'),        validateBody(createRouteSchema),     ctrl.create)
router.get('/:routeId', requirePermission('route:read'), ctrl.getOne)
router.patch('/:routeId', requirePermission('route:update'), validateBody(updateRouteSchema),  ctrl.update)
router.delete('/:routeId', requirePermission('route:delete'), ctrl.remove)

export default router
