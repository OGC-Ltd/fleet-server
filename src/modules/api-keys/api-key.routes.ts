import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody } from '../../middleware/validate.js'
import { createApiKeySchema, updateApiKeySchema } from './api-key.schema.js'
import * as ctrl from './api-key.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/',         ctrl.list)
router.post('/',        validateBody(createApiKeySchema), ctrl.create)
router.get('/:keyId',   ctrl.getOne)
router.patch('/:keyId', validateBody(updateApiKeySchema), ctrl.update)
router.post('/:keyId/revoke', ctrl.revoke)

export default router
