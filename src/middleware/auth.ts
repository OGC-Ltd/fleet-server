import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { UnauthorizedError, ForbiddenError } from '../core/errors/errors.js'
import { prisma } from '../lib/prisma.js'

interface AccessTokenPayload {
  sub: string      // user id (users.id)
  email: string
  typ: 'access' | 'refresh'
  exp: number
}

type AuthUser = NonNullable<Awaited<ReturnType<typeof lookupUserByEmail>>>

// Short-TTL in-memory session cache — the user lookup used to hit the remote
// DB (~1s per round trip on the pooler) on EVERY request, which put a
// multi-second floor under every API call regardless of endpoint caching.
// A just-suspended/terminated user can keep access for at most USER_CACHE_MS.
const USER_CACHE_MS = 60_000
const userCache = new Map<string, { user: AuthUser; fetchedAt: number }>()
const BYPASS_KEY = 'auth-bypass' // no '@' — can never collide with an email key

const readUserCache = (key: string): AuthUser | null => {
  const hit = userCache.get(key)
  return hit && Date.now() - hit.fetchedAt < USER_CACHE_MS ? hit.user : null
}

const lookupUserByEmail = (email: string) =>
  prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, organisationId: true, email: true, fullName: true, status: true },
  })

/**
 * Verifies the Bearer JWT (signed by auth.service with JWT_SECRET), then
 * resolves the matching User in our DB (via the 60s in-memory cache above)
 * and attaches it to req.user.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    // Auth bypass: auto-attach the first active user — for development/single-org use
    if (env.AUTH_BYPASS) {
      let user = readUserCache(BYPASS_KEY)
      if (!user) {
        user = await prisma.user.findFirst({
          where: { status: 'ACTIVE', deletedAt: null },
          select: { id: true, organisationId: true, email: true, fullName: true, status: true },
        })
        if (!user) throw new UnauthorizedError('No active user found (AUTH_BYPASS mode)')
        userCache.set(BYPASS_KEY, { user, fetchedAt: Date.now() })
      }
      req.user = user
      return next()
    }

    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Missing Bearer token')

    const token = header.slice(7)
    const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload
    // A refresh token is NOT a credential for API calls
    if (payload.typ !== 'access') throw new UnauthorizedError('Invalid token')

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
 * Ensures the authenticated user belongs to the organisation in the route param.
 * Must be used AFTER `authenticate`.
 */
export const requireOrgAccess: RequestHandler = (req, _res, next) => {
  if (env.AUTH_BYPASS) return next()
  const orgId = req.params['orgId'] as string | undefined
  if (!orgId) return next()
  if (req.user?.organisationId !== orgId) {
    return next(new ForbiddenError('Access to this organisation is denied'))
  }
  next()
}
