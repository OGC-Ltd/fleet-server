/**
 * Refuse to serve while authentication is bypassed.
 *
 * `AUTH_BYPASS` attaches whichever account `AUTH_BYPASS_EMAIL` names WITHOUT
 * verifying a token, so every request arrives as that user. On the routes it
 * was built for — read-only fleet data during development — that is merely
 * permissive. On these routes it is catastrophic: the bypass account on the
 * production box is a PLATFORM user, so a permission check grades it and
 * passes, and account creation, role assignment and suspension become
 * available to anyone who can reach the host.
 *
 * A permission gate cannot close an authentication hole. `requirePermission`
 * and even `requirePermissionStrict` ask "may THIS user do this" — a question
 * with the wrong answer when the server decided who the user was without being
 * told.
 *
 * So these routes fail closed instead. The cost is that they do nothing until
 * AUTH_BYPASS is off, which is a deployment step somebody has to take
 * deliberately; the alternative is shipping an open door and relying on nobody
 * finding it.
 */

import type { RequestHandler } from 'express'
import { env } from '../config/env.js'
import { ForbiddenError } from '../core/errors/errors.js'
import { logger } from '../lib/logger.js'

export const requireRealAuth: RequestHandler = (req, _res, next) => {
  if (!env.AUTH_BYPASS) return next()

  logger.error(
    { route: `${req.method} ${req.baseUrl}${req.path}` },
    'refused: account administration is unavailable while AUTH_BYPASS is enabled',
  )
  next(new ForbiddenError(
    'Account administration is disabled because the server is running with authentication bypassed. Set AUTH_BYPASS=false and restart.',
  ))
}
