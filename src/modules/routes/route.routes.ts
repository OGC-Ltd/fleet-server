import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createRouteSchema, updateRouteSchema, routeListQuerySchema } from './route.schema.js'
import * as ctrl from './route.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/',         validateQuery(routeListQuerySchema), ctrl.list)
router.post('/',        validateBody(createRouteSchema),     ctrl.create)
router.get('/:routeId', ctrl.getOne)
router.patch('/:routeId', validateBody(updateRouteSchema),  ctrl.update)
router.delete('/:routeId', ctrl.remove)

export default router
