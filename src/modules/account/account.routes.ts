/**
 * Self-service account routes.
 *
 * ## Why /api/v1/account and not /api/v1/auth
 *
 * The dashboard excludes `/api/v1/auth/` from its 401 refresh-and-replay
 * (services/api.js) — deliberately, because retrying a failed sign-in makes no
 * sense. These routes are ordinary authenticated calls that happen to be about
 * the account, so mounting them under /auth would mean a user whose access
 * token aged out while the form was open gets a hard failure instead of a
 * transparent refresh.
 *
 * ## The auth boundary is the shape of this file
 *
 * Public routes are declared FIRST, then `router.use(authenticate)`, then the
 * authenticated ones. Everything below that line requires a session and
 * everything above it does not, which makes the boundary one thing to read
 * rather than five decorators to check.
 *
 * ## No permission checks, on purpose
 *
 * The authenticated routes act on `req.user.id` and there is no `:userId`
 * anywhere in this module — so there is no way to address another account and
 * nothing to authorise beyond being signed in. See account.service.ts.
 */

import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requireRealAuth } from '../../middleware/requireRealAuth.js'
import { validateBody } from '../../middleware/validate.js'
import { passwordResetLimiter, sensitiveLimiter } from '../../middleware/rateLimiter.js'
import {
  updateProfileSchema, changePasswordSchema, forgotPasswordSchema, setupSchema,
} from './account.schema.js'
import * as ctrl from './account.controller.js'

const router = Router()

// Nothing in this module is safe to serve when the server is deciding who the
// caller is without checking a token. See requireRealAuth.
router.use(requireRealAuth)

// ── Public ───────────────────────────────────────────────────────────────────
// Reachable without a session: somebody who has forgotten their password, or
// who has an invite and no password yet, has no session to offer.

router.post('/forgot-password', passwordResetLimiter, validateBody(forgotPasswordSchema), ctrl.forgotPassword)
router.get('/setup/:token', passwordResetLimiter, ctrl.describeSetup)
router.post('/setup', passwordResetLimiter, validateBody(setupSchema), ctrl.completeSetup)

// ── Everything below requires a session ──────────────────────────────────────
router.use(authenticate)

router.get('/profile', ctrl.getProfile)
router.patch('/profile', validateBody(updateProfileSchema), ctrl.updateProfile)
router.patch('/password', sensitiveLimiter, validateBody(changePasswordSchema), ctrl.changePassword)

// Devices. `revoke-all` is declared BEFORE `/:sessionId` — a literal has to
// beat the parameter that would otherwise swallow it.
router.get('/sessions', ctrl.listSessions)
router.post('/sessions/revoke-all', ctrl.revokeAllSessions)
router.delete('/sessions/:sessionId', ctrl.revokeSession)

export default router
