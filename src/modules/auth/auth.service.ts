import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { env } from '../../config/env.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import { prisma } from '../../lib/prisma.js'
import type { LoginDto, RefreshDto } from './auth.schema.js'

// Self-contained auth: credentials live in users.password_hash (bcrypt) and
// tokens are HS256 JWTs signed with JWT_SECRET. Response shape is unchanged
// from the old Supabase-backed implementation, so no client changes.
const ACCESS_TTL_S = 60 * 60 // 1 hour
const REFRESH_TTL_S = 30 * 24 * 60 * 60 // 30 days

export interface TokenPayload {
  sub: string // user id
  email: string
  typ: 'access' | 'refresh'
}

// Accounts synced from the RaiFactorySuite driver registry carry no email (the
// provider holds none) and therefore cannot hold a session — the token subject
// is the email, and login only ever matches a non-null one.
const issueTokens = (user: { id: string; email: string | null }) => {
  if (!user.email) throw new UnauthorizedError('Account cannot sign in')
  const email = user.email
  return {
    accessToken: jwt.sign(
      { sub: user.id, email, typ: 'access' } satisfies TokenPayload,
      env.JWT_SECRET,
      { expiresIn: ACCESS_TTL_S },
    ),
    refreshToken: jwt.sign(
      { sub: user.id, email, typ: 'refresh' } satisfies TokenPayload,
      env.JWT_SECRET,
      { expiresIn: REFRESH_TTL_S },
    ),
    expiresIn: ACCESS_TTL_S,
  }
}

const userSelect = {
  id: true,
  organisationId: true,
  email: true,
  fullName: true,
  status: true,
} as const

export async function login(dto: LoginDto) {
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
  return { ...issueTokens(user), user: safeUser }
}

export async function refresh(dto: RefreshDto) {
  let payload: TokenPayload
  try {
    payload = jwt.verify(dto.refreshToken, env.JWT_SECRET) as TokenPayload
  } catch {
    throw new UnauthorizedError('Invalid refresh token')
  }
  if (payload.typ !== 'refresh') throw new UnauthorizedError('Invalid refresh token')

  // Re-check the account on every refresh so a suspended/terminated/deleted
  // user is locked out within one access-token lifetime.
  const user = await prisma.user.findFirst({
    where: { id: payload.sub, deletedAt: null },
    select: userSelect,
  })
  if (!user) throw new UnauthorizedError('Invalid refresh token')
  if (user.status !== 'ACTIVE') throw new UnauthorizedError(`Account ${user.status.toLowerCase()}`)

  return issueTokens(user)
}

export async function logout(_accessToken: string) {
  // Stateless JWTs — nothing to invalidate server-side. The client discards
  // its tokens; the access token ages out within ACCESS_TTL_S.
}
