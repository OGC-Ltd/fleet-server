/**
 * Minting and consuming password-setting links.
 *
 * The security properties live here rather than in the routes, so there is one
 * place to read them:
 *
 *   · The raw token is returned to the caller ONCE, at mint time, and never
 *     stored. Only its sha256 goes in the table, so a database read — a backup,
 *     a support query, a leak — yields no working links.
 *   · Minting revokes any live token of the same purpose for that user first.
 *     Re-inviting somebody therefore kills the earlier link rather than leaving
 *     two valid ways in.
 *   · Consumption is a transaction: the password write and the consumedAt
 *     stamp land together or neither does. A crash between them would
 *     otherwise leave a used link still usable.
 */

import type { PasswordTokenPurpose } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { mintToken, hashToken } from '../../lib/tokens.js'
import { env } from '../../config/env.js'

export type TokenPurpose = 'INVITE' | 'RESET'

const ttlFor = (purpose: TokenPurpose): number =>
  purpose === 'INVITE' ? env.INVITE_TTL_S : env.PASSWORD_RESET_TTL_S

export interface MintedToken {
  /** Hand this to the person. It is not recoverable afterwards. */
  raw: string
  expiresAt: Date
}

export interface MintContext {
  createdById?: string | null
  ip?: string | null
  userAgent?: string | null
}

/**
 * Issue a link for this user, invalidating any earlier live one.
 *
 * The revoke-then-create pair is NOT wrapped in a transaction on purpose: if
 * the create failed after the revoke, the outcome is "no valid link", which is
 * the safe direction. Wrapping it so both survive together would mean a failed
 * create leaves the OLD link alive, which is the unsafe one.
 */
export async function mintPasswordToken(
  userId: string,
  purpose: TokenPurpose,
  ctx: MintContext = {},
): Promise<MintedToken> {
  await revokeLiveTokens(userId, purpose, 'superseded by a newer link')

  const raw = mintToken()
  const expiresAt = new Date(Date.now() + ttlFor(purpose) * 1000)

  await prisma.passwordToken.create({
    data: {
      userId,
      purpose: purpose as PasswordTokenPurpose,
      tokenHash: hashToken(raw),
      expiresAt,
      createdById: ctx.createdById ?? null,
      requestedIp: ctx.ip ?? null,
      requestedUa: ctx.userAgent ?? null,
    },
  })

  return { raw, expiresAt }
}

/** Kill every usable token of this purpose for a user. Returns how many. */
export async function revokeLiveTokens(
  userId: string,
  purpose: TokenPurpose,
  reason: string,
): Promise<number> {
  const { count } = await prisma.passwordToken.updateMany({
    where: {
      userId,
      purpose: purpose as PasswordTokenPurpose,
      consumedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
  return count
}

export interface LiveToken {
  id: string
  userId: string
  purpose: TokenPurpose
  expiresAt: Date
  user: { id: string; email: string | null; fullName: string; status: string; passwordHash: string | null }
}

/**
 * Resolve a raw token to its row, or null.
 *
 * Every liveness condition is in the WHERE clause rather than checked
 * afterwards, so there is no path where a caller forgets one. An expired,
 * consumed or revoked token is indistinguishable from a token that never
 * existed — which is what a caller should be able to say to the outside world.
 */
export async function findLiveToken(raw: string): Promise<LiveToken | null> {
  if (!raw) return null
  const row = await prisma.passwordToken.findFirst({
    where: {
      tokenHash: hashToken(raw),
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      userId: true,
      purpose: true,
      expiresAt: true,
      user: {
        select: { id: true, email: true, fullName: true, status: true, passwordHash: true },
      },
    },
  })
  return row as LiveToken | null
}

/**
 * Set the password this token was issued for, and burn every link to it.
 *
 * All three writes are in one transaction: a password changed without the token
 * being marked consumed leaves a live link that sets it again.
 *
 * ## It burns the OTHER live tokens too, not just this one
 *
 * `mintPasswordToken` only revokes tokens of the SAME purpose, so an invited
 * user who gave up on their invite and used "forgot password" instead has two
 * live links: the reset they just used, and the original invite. Consuming only
 * the reset left that invite valid — `findLiveToken` matches on the hash and
 * never looks at the purpose — so the invitation email kept working against an
 * account that now had a password and a person using it. Anyone still holding
 * that email could set the password again and take the account.
 *
 * That was found on a live account. It is not an edge case either: giving up on
 * a failing invite link and asking for a reset is the ordinary thing to do, and
 * the setup routes' rate limit was making invite links fail.
 *
 * `updateMany` rather than a second `update`, because there may be none.
 */
export async function consumeToken(tokenId: string, userId: string, passwordHash: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        // Setting a password from a link is a password change like any other,
        // and has to count. Otherwise an account set up by invitation looks
        // like it has never had its password set.
        passwordChangedAt: new Date(),
        passwordChangeCount: { increment: 1 },
      },
    }),
    prisma.passwordToken.update({
      where: { id: tokenId },
      data: { consumedAt: new Date() },
    }),
    prisma.passwordToken.updateMany({
      where: {
        userId,
        id: { not: tokenId },
        consumedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedReason: 'a password was set from another link',
      },
    }),
  ])
}

/**
 * Was a link issued for this user very recently?
 *
 * Guards the public forgot-password route against mail-bombing one address.
 * IP rate limiting cannot do this job — the whole point of the attack is many
 * sources aimed at one inbox.
 */
export async function hasRecentToken(userId: string, purpose: TokenPurpose, withinMs = 60_000): Promise<boolean> {
  const found = await prisma.passwordToken.findFirst({
    where: {
      userId,
      purpose: purpose as PasswordTokenPurpose,
      createdAt: { gt: new Date(Date.now() - withinMs) },
    },
    select: { id: true },
  })
  return Boolean(found)
}
