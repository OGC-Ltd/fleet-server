import { Router } from 'express'
import { authLimiter } from '../../middleware/rateLimiter.js'
import { validateBody } from '../../middleware/validate.js'
import { loginSchema, refreshSchema } from './auth.schema.js'
import { authenticate } from '../../middleware/auth.js'
import { loginHandler, refreshHandler, logoutHandler, meHandler } from './auth.controller.js'

const router = Router()

router.post('/login', authLimiter, validateBody(loginSchema), loginHandler)
router.post('/refresh', authLimiter, validateBody(refreshSchema), refreshHandler)
// No `authenticate`: logging out must work when the access token has already
// expired, which is exactly when a user reaches for it. The refresh cookie
// identifies the session to revoke, and presenting a token you already hold
// grants nothing.
router.post('/logout', logoutHandler)

// The dashboard's first call after a refresh: identity, reachable
// organisations, permissions per organisation, and the vehicle scope.
router.get('/me', authenticate, meHandler)

export default router
