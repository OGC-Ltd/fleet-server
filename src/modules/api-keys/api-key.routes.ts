import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validateBody } from '../../middleware/validate.js'
import { createApiKeySchema, updateApiKeySchema } from './api-key.schema.js'
import * as ctrl from './api-key.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('ingest_key:read'),         ctrl.list)
router.post('/', requirePermission('ingest_key:create'),        validateBody(createApiKeySchema), ctrl.create)
router.get('/:keyId', requirePermission('ingest_key:read'),   ctrl.getOne)
router.patch('/:keyId', requirePermission('ingest_key:update'), validateBody(updateApiKeySchema), ctrl.update)
router.post('/:keyId/revoke', requirePermission('ingest_key:delete'), ctrl.revoke)

export default router
