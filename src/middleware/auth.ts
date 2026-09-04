import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { UnauthorizedError, ForbiddenError } from '../core/errors/errors.js'
import { prisma } from '../lib/prisma.js'
import { logger } from '../lib/logger.js'
import { resolveSubject, canReachOrg, vehicleScopeIn } from '../lib/authz/subject.js'
import { ACCESS_COOKIE } from '../modules/auth/auth.cookies.js'

interface AccessTokenPayload {
  sub: string      // user id (users.id)
  email: string
  /** auth_sessions.id this token was minted for — see auth.service.issueSession. */
  sid?: string
  typ: 'access' | 'refresh'
  exp: number
}

type AuthUser = NonNullable<Awaited<ReturnType<typeof lookupUserByEmail>>>

// Short-TTL in-memory session cache — the user lookup used to hit the remote
// DB (~1s per round trip on the pooler) on EVERY request, which put a
// multi-second floor under every API call regardless of endpoint caching.
// A just-suspended/terminated user can keep access for at most USER_CACHE_MS.
//
// This caches IDENTITY only. Permissions and the vehicle scope are resolved by
// lib/authz/subject, which caches in Redis instead — process-local memory
// cannot be invalidated across pm2 workers, and a revoked role that keeps
// working on one worker is a different class of problem from a stale name.
const USER_CACHE_MS = 60_000
const userCache = new Map<string, { user: AuthUser; fetchedAt: number }>()
const BYPASS_KEY = 'auth-bypass' // no '@' — can never collide with an email key

/**
 * Drop a user from the identity cache.
 *
 * The cache is keyed by EMAIL and holds `fullName` among other things, so a
 * user who renames themselves keeps seeing the old name from /auth/me for up
 * to USER_CACHE_MS. Sixty seconds of a stale display name is not a security
 * problem, but it looks like the save silently failed, which is worse than the
 * wait.
 *
 * Note this clears the cache in THIS process only. Under pm2 cluster mode the
 * other workers keep their copy until it ages out — which is why the account
 * routes return the updated user in the response body rather than expecting
 * the client to re-fetch it.
 */
export function forgetUser(email: string | null | undefined): void {
  if (email) userCache.delete(email)
}

const readUserCache = (key: string): AuthUser | null => {
  const hit = userCache.get(key)
  return hit && Date.now() - hit.fetchedAt < USER_CACHE_MS ? hit.user : null
}

const USER_FIELDS = {
  id: true, organisationId: true, email: true, fullName: true, status: true,
} as const

const lookupUserByEmail = (email: string) =>
  prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: USER_FIELDS,
  })

/**
 * The user AUTH_BYPASS runs as.
 *
 * `AUTH_BYPASS_EMAIL` names them. Without it this falls back to the old
 * behaviour — `findFirst` with no `orderBy`, so whichever row Postgres happens
 * to return, in practice a driver in one arbitrary organisation. That made
 * local behaviour depend on physical row order and is worth a warning.
 */
async function bypassUser(): Promise<AuthUser> {
  const cached = readUserCache(BYPASS_KEY)
  if (cached) return cached

  let user: AuthUser | null = null
  if (env.AUTH_BYPASS_EMAIL) {
    user = await lookupUserByEmail(env.AUTH_BYPASS_EMAIL)
    if (!user) throw new UnauthorizedError(`AUTH_BYPASS_EMAIL: no user ${env.AUTH_BYPASS_EMAIL}`)
  } else {
    user = await prisma.user.findFirst({
      where:   { status: 'ACTIVE', deletedAt: null },
      orderBy: { createdAt: 'asc' },   // at least make it the SAME arbitrary user each time
      select:  USER_FIELDS,
    })
    if (!user) throw new UnauthorizedError('No active user found (AUTH_BYPASS mode)')
    logger.warn(
      { userId: user.id, email: user.email },
      'AUTH_BYPASS with no AUTH_BYPASS_EMAIL — every request runs as this arbitrary account',
    )
  }

  userCache.set(BYPASS_KEY, { user, fetchedAt: Date.now() })
  return user
}

/**
 * Verifies the Bearer JWT (signed by auth.service with JWT_SECRET), then
 * resolves the matching User in our DB (via the 60s in-memory cache above)
 * and attaches it to req.user.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    // Skips the TOKEN, not the authorisation — the request still resolves to a
    // real account, and requireOrgAccess/requirePermission still judge it
    // against that account's roles.
    if (env.AUTH_BYPASS) {
      req.user = await bypassUser()
      return next()
    }

    // Header first, then the httpOnly cookie. The cookie exists for SSE:
    // `EventSource` cannot set an Authorization header, so a long-lived stream
    // would otherwise need the token in the query string - where nginx writes
    // it into access.log. Ordinary fetch calls still send the header.
    const header = req.headers.authorization
    const cookies = (req as { cookies?: Record<string, string> }).cookies
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : cookies?.[ACCESS_COOKIE]
    if (!token) throw new UnauthorizedError('Missing Bearer token')
    const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload
    // A refresh token is NOT a credential for API calls
    if (payload.typ !== 'access') throw new UnauthorizedError('Invalid token')

    // Carried through so the account page can mark the caller's own device in
    // its session list. Nothing authorises on it.
    req.authSessionId = payload.sid

    let user = readUserCache(payload.email)
    if (!user) {
      user = await lookupUserByEmail(payload.email)
      if (!user) throw new UnauthorizedError('User account not found')
      userCache.set(payload.email, { user, fetchedAt: Date.now() })
    }
    if (user.status === 'SUSPENDED') throw new ForbiddenError('Account suspended')
    if (user.status === 'TERMINATED') throw new ForbiddenError('Account terminated')

    req.user = user
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * May this caller address the organisation named in the path?
 *
 * Answered from MEMBERSHIP, not from `user.organisationId`. A user's home org
 * is who employs them; membership is which tenants they may read, and one
 * person can now hold several with a different role in each.
 *
 * Two behaviours changed here, both of which were holes:
 *
 *   - it used to return `next()` when `:orgId` was absent. Every router this
 *     guards is mounted under `/organisations/:orgId`, so a missing param means
 *     the route was mounted wrong — and the old code answered that by allowing
 *     the request. It now fails closed.
 *   - it used to be a complete no-op under AUTH_BYPASS, which is the mode the
 *     live box runs in. Bypass now only skips the token.
 *
 * Denials respect AUTHZ_ENFORCE, so the shadow-mode rollout applies here too:
 * with it off, a would-be denial is logged and the request proceeds.
 */
export const requireOrgAccess: RequestHandler = async (req, _res, next) => {
  try {
    const orgId = req.params['orgId'] as string | undefined
    const userId = req.user?.id
    if (!userId) throw new UnauthorizedError('Not authenticated')

    if (!orgId) {
      // Fail closed. There is no correct way to scope a request whose tenant
      // never resolved.
      if (!env.AUTHZ_ENFORCE) {
        logger.warn({ path: req.originalUrl }, 'authz: org-scoped route with no :orgId (shadow mode) — allowing')
        return next()
      }
      throw new ForbiddenError('Organisation not resolved for this route')
    }

    const subject = await resolveSubject(userId)
    if (!canReachOrg(subject, orgId)) {
      const detail = { userId, orgId, path: req.originalUrl }
      if (!env.AUTHZ_ENFORCE) {
        logger.warn(detail, 'authz: WOULD DENY organisation (shadow mode) — allowing')
      } else {
        throw new ForbiddenError('Access to this organisation is denied')
      }
    }

    // Available to handlers that are not behind requirePermission — notably the
    // SSE handshake, where the vehicle scope decides what the stream may carry.
    //
    // Withheld entirely while AUTHZ_ENFORCE is off: the scope is a silent
    // filter, not a denial, and applying it during a shadow pass would blank
    // the map for every organisation the caller is not already a member of.
    const scope = vehicleScopeIn(subject, orgId)
    if (scope !== null && !env.AUTHZ_ENFORCE) {
      logger.warn(
        { userId, orgId, visibleVehicles: scope.size },
        'authz: WOULD NARROW to a vehicle subset (shadow mode) — showing the whole fleet',
      )
    }
    req.authz = {
      userId,
      orgId,
      isPlatform: subject.isPlatform,
      vehicleIds: env.AUTHZ_ENFORCE ? scope : null,
    }

    next()
  } catch (err) {
    next(err)
  }
}
