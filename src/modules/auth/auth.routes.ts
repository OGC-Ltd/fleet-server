import { Router } from 'express'
import { authLimiter } from '../../middleware/rateLimiter.js'
import { validateBody } from '../../middleware/validate.js'
import { authenticate } from '../../middleware/auth.js'
import { loginSchema, refreshSchema } from './auth.schema.js'
import { loginHandler, refreshHandler, logoutHandler } from './auth.controller.js'

const router = Router()

router.post('/login', authLimiter, validateBody(loginSchema), loginHandler)
router.post('/refresh', authLimiter, validateBody(refreshSchema), refreshHandler)
router.post('/logout', authenticate, logoutHandler)

export default router
