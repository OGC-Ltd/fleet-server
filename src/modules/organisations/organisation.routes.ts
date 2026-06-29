import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createOrgSchema, updateOrgSchema, listOrgQuerySchema } from './organisation.schema.js'
import * as ctrl from './organisation.controller.js'

const router = Router()

router.use(authenticate)

router.get('/', validateQuery(listOrgQuerySchema), ctrl.list)
router.post('/', validateBody(createOrgSchema), ctrl.create)
router.get('/:id', ctrl.getOne)
router.patch('/:id', validateBody(updateOrgSchema), ctrl.update)

export default router
