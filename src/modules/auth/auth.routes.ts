import { Router } from 'express'
import { authLimiter, refreshLimiter, refreshIpLimiter } from '../../middleware/rateLimiter.js'
import { deviceId } from '../../middleware/device-id.js'
import { validateBody } from '../../middleware/validate.js'
import { loginSchema, refreshSchema } from './auth.schema.js'
import { authenticate } from '../../middleware/auth.js'
import { loginHandler, refreshHandler, logoutHandler, meHandler } from './auth.controller.js'

const router = Router()

router.post('/login', authLimiter, validateBody(loginSchema), loginHandler)
// Address, then machine — see account.routes.ts.
//
// `deviceId` is on THIS route and not on `login`, and that is the whole of the
// asymmetry: login is keyed per-IP and must be, because a key the caller can
// discard is not a brute-force defence. Mounting it there would issue a cookie
// nothing reads and quietly invite someone to key on it later.
router.post('/refresh', deviceId, refreshIpLimiter, refreshLimiter, validateBody(refreshSchema), refreshHandler)
// No `authenticate`: logging out must work when the access token has already
// expired, which is exactly when a user reaches for it. The refresh cookie
// identifies the session to revoke, and presenting a token you already hold
// grants nothing.
router.post('/logout', logoutHandler)

// The dashboard's first call after a refresh: identity, reachable
// organisations, permissions per organisation, and the vehicle scope.
router.get('/me', authenticate, meHandler)

export default router
