import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { UnauthorizedError, ForbiddenError } from '../core/errors/errors.js'
import { prisma } from '../lib/prisma.js'

interface SupabaseJwtPayload {
  sub: string      // Supabase auth user ID
  email: string
  exp: number
}

/**
 * Verifies the Bearer JWT (Supabase-signed), then resolves the matching
 * User in our DB and attaches it to req.user.
 *
 * BOTTLENECK: This performs a DB lookup on every request.
 * Mitigation: Add Redis session cache keyed on JWT `sub` with a short TTL (60s).
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    // Auth bypass: auto-attach the first active user — for development/single-org use
    if (env.AUTH_BYPASS) {
      const user = await prisma.user.findFirst({
        where: { status: 'ACTIVE', deletedAt: null },
        select: { id: true, organisationId: true, email: true, fullName: true, status: true },
      })
      if (!user) throw new UnauthorizedError('No active user found (AUTH_BYPASS mode)')
      req.user = user
      return next()
    }

    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Missing Bearer token')

    const token = header.slice(7)
    const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET) as SupabaseJwtPayload

    const user = await prisma.user.findFirst({
      where: { email: payload.email, deletedAt: null },
      select: { id: true, organisationId: true, email: true, fullName: true, status: true },
    })

    if (!user) throw new UnauthorizedError('User account not found')
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
