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
import { deviceId } from '../../middleware/device-id.js'
import { requireRealAuth } from '../../middleware/requireRealAuth.js'
import { validateBody } from '../../middleware/validate.js'
import {
  passwordResetLimiter, passwordResetIpLimiter,
  setupLimiter, setupIpLimiter,
  sensitiveLimiter,
} from '../../middleware/rateLimiter.js'
import {
  updateProfileSchema, changePasswordSchema, forgotPasswordSchema, setupSchema,
} from './account.schema.js'
import * as ctrl from './account.controller.js'

const router = Router()

// Nothing in this module is safe to serve when the server is deciding who the
// caller is without checking a token. See requireRealAuth.
router.use(requireRealAuth)

// Ahead of every limiter below, because that is what guarantees `req.deviceId`
// is set by the time a keyGenerator runs.
//
// Mounted HERE rather than globally in app.ts on purpose. The id is read by
// four routes — three in this file and /auth/refresh — and mounting it on the
// whole app would hang a Set-Cookie on every telemetry POST from hardware that
// holds no cookies, several hundred times a minute, to no end.
router.use(deviceId)

// ── Public ───────────────────────────────────────────────────────────────────
// Reachable without a session: somebody who has forgotten their password, or
// who has an invite and no password yet, has no session to offer.

// Two limiters each, and the order is the sentence: this ADDRESS, then this
// MACHINE. The per-machine one is the limit people meet; the per-IP one exists
// only to bound a caller who throws away device ids to mint fresh buckets.
//
// The two groups are deliberately far apart. Asking for a reset mails an
// address the caller chose and is worth being stingy about. Opening the link
// that mail contained sends nothing and requires a single-use token the caller
// must already hold — it was on the reset budget until it turned out that a
// setup costs two requests out of five, shared by everyone behind one office
// NAT, and invited users were being told they had made too many requests.
router.post('/forgot-password',
  passwordResetIpLimiter, passwordResetLimiter,
  validateBody(forgotPasswordSchema), ctrl.forgotPassword)

router.get('/setup/:token',
  setupIpLimiter, setupLimiter,
  ctrl.describeSetup)

router.post('/setup',
  setupIpLimiter, setupLimiter,
  validateBody(setupSchema), ctrl.completeSetup)

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
