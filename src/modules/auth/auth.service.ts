import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import type { LoginDto } from './auth.schema.js'

/**
 * Self-contained auth: credentials live in users.password_hash (bcrypt).
 *
 * The two tokens are deliberately different KINDS of thing.
 *
 * The ACCESS token stays a stateless HS256 JWT, checked with no database round
 * trip, and is short — 15 minutes by default, down from an hour. Statelessness
 * is what keeps it cheap; the short life is what bounds the damage, because a
 * revoked account keeps working until its current access token expires.
 *
 * The REFRESH token is NOT a JWT. It is 32 random bytes, stored as a sha256
 * hash in `auth_sessions`. Once a token has to be looked up anyway — and it
 * does, because rotation means knowing whether this exact token has been spent
 * — a signature proves nothing the lookup has not already established. Signing
 * it would only make it longer.
 *
 * ROTATION WITH REUSE DETECTION. Every refresh spends the presented token and
 * issues a successor in the same `familyId`. Presenting a token that has
 * already been spent means two parties hold it: the legitimate client and
 * whoever copied it. There is no way to tell which one is asking, so the whole
 * family is revoked and both are forced to log in again. A stolen refresh token
 * therefore buys at most one rotation before it locks itself out and leaves a
 * record saying so.
 */

export interface TokenPayload {
  sub: string          // user id
  email: string
  /** The auth_sessions row this token was minted from. */
  sid?: string
  typ: 'access' | 'refresh'
}

const userSelect = {
  id: true,
  organisationId: true,
  email: true,
  fullName: true,
  status: true,
} as const

type SafeUser = { id: string; organisationId: string; email: string | null; fullName: string; status: string }

export type SessionContext = { userAgent?: string | null; ip?: string | null }

const sha256 = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex')

/** Opaque, unguessable, and URL-safe so it survives a cookie round trip intact. */
const mintRefreshToken = (): string => crypto.randomBytes(32).toString('base64url')

function signAccessToken(user: { id: string; email: string | null }, sid: string): string {
  // Accounts synced from the RaiFactorySuite driver registry carry no email
  // (the provider holds none) and therefore cannot hold a session — the token
  // subject is the email, and login only ever matches a non-null one.
  if (!user.email) throw new UnauthorizedError('Account cannot sign in')
  return jwt.sign(
    { sub: user.id, email: user.email, sid, typ: 'access' } satisfies TokenPayload,
    env.JWT_SECRET,
    { expiresIn: env.ACCESS_TTL_S },
  )
}

/** Open a new session family, or extend an existing one by one rotation. */
async function issueSession(
  user: { id: string; email: string | null },
  ctx: SessionContext,
  familyId?: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const refreshToken = mintRefreshToken()
  const session = await prisma.authSession.create({
    data: {
      userId:    user.id,
      familyId:  familyId ?? crypto.randomUUID(),
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TTL_S * 1000),
      userAgent: ctx.userAgent?.slice(0, 512) ?? null,
      ip:        ctx.ip ?? null,
    },
    select: { id: true },
  })

  return {
    accessToken: signAccessToken(user, session.id),
    refreshToken,
    expiresIn:   env.ACCESS_TTL_S,
  }
}

export async function login(dto: LoginDto, ctx: SessionContext = {}) {
  const user = await prisma.user.findFirst({
    where: { email: dto.email, deletedAt: null },
    select: { ...userSelect, passwordHash: true },
  })

  // One generic message for unknown email / no password set / wrong password —
  // a distinct "no such account" reply would let callers enumerate emails.
  if (!user?.passwordHash) throw new UnauthorizedError('Invalid credentials')
  const valid = await bcrypt.compare(dto.password, user.passwordHash)
  if (!valid) throw new UnauthorizedError('Invalid credentials')

  if (user.status !== 'ACTIVE') throw new UnauthorizedError(`Account ${user.status.toLowerCase()}`)

  const { passwordHash: _ph, ...safeUser } = user
  return { ...(await issueSession(user, ctx)), user: safeUser as SafeUser }
}

export async function refresh(rawToken: string, ctx: SessionContext = {}) {
  if (!rawToken) throw new UnauthorizedError('Invalid refresh token')

  const session = await prisma.authSession.findUnique({
    where:  { tokenHash: sha256(rawToken) },
    select: {
      id: true, userId: true, familyId: true,
      expiresAt: true, rotatedAt: true, revokedAt: true,
    },
  })

  // Unknown token. Says nothing about whether it was never valid or was pruned;
  // the caller gets the same answer either way.
  if (!session) throw new UnauthorizedError('Invalid refresh token')

  if (session.revokedAt) throw new UnauthorizedError('Invalid refresh token')

  // REUSE. This token was already exchanged, so a copy of it is in circulation.
  // Revoke the entire family rather than this row: the honest client's current
  // token is a descendant of this one, and leaving it live would leave the
  // thief's next rotation working too.
  if (session.rotatedAt) {
    await prisma.authSession.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data:  { revokedAt: new Date(), revokedReason: 'refresh token reuse detected' },
    })
    logger.warn(
      { userId: session.userId, familyId: session.familyId, ip: ctx.ip },
      'auth: refresh token reuse — session family revoked',
    )
    throw new UnauthorizedError('Invalid refresh token')
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError('Invalid refresh token')
  }

  // Re-check the account on every refresh so a suspended/terminated/deleted
  // user is locked out within one access-token lifetime.
  const user = await prisma.user.findFirst({
    where:  { id: session.userId, deletedAt: null },
    select: userSelect,
  })
  if (!user) throw new UnauthorizedError('Invalid refresh token')
  if (user.status !== 'ACTIVE') throw new UnauthorizedError(`Account ${user.status.toLowerCase()}`)

  // Spend the presented token, then mint its successor in the same family.
  await prisma.authSession.update({
    where: { id: session.id },
    data:  { rotatedAt: new Date() },
  })

  return { ...(await issueSession(user, ctx, session.familyId)), user: user as SafeUser }
}

/**
 * End this device's session chain.
 *
 * Revokes the whole FAMILY, not the one row: the family is the device, and
 * leaving an unrotated ancestor live would let a saved copy resume.
 */
export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return
  const session = await prisma.authSession.findUnique({
    where:  { tokenHash: sha256(rawToken) },
    select: { familyId: true },
  })
  if (!session) return
  await prisma.authSession.updateMany({
    where: { familyId: session.familyId, revokedAt: null },
    data:  { revokedAt: new Date(), revokedReason: 'logout' },
  })
}

/** Sign every device out. For a password reset, or an account being disabled. */
export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const { count } = await prisma.authSession.updateMany({
    where: { userId, revokedAt: null },
    data:  { revokedAt: new Date(), revokedReason: reason },
  })
  return count
}
