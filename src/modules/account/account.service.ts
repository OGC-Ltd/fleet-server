/**
 * What a signed-in person may do to their OWN account.
 *
 * ## The security property is structural
 *
 * Every function here takes the caller's own id from `req.user`, and there is
 * no `:userId` parameter anywhere in the module. That is why none of these
 * routes carries a permission check and why none is needed: there is no way to
 * address somebody else's account through this surface, so there is nothing to
 * authorise beyond being signed in.
 *
 * Role, email, status and organisation are absent for the same structural
 * reason — not filtered out, simply never written. The schemas are `.strict()`
 * so a body that mentions them is refused rather than quietly ignored.
 */

import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { BadRequestError, NotFoundError } from '../../core/errors/errors.js'
import { forgetUser } from '../../middleware/auth.js'
import * as authService from '../auth/auth.service.js'
import type { SessionContext } from '../auth/auth.service.js'
import { sendMail } from '../../lib/mailer/mailer.js'
import { passwordChangedEmail, resetEmail, inviteEmail } from '../../lib/mailer/templates.js'
import { env } from '../../config/env.js'
import {
  mintPasswordToken, findLiveToken, consumeToken, revokeLiveTokens, hasRecentToken,
} from './tokens.service.js'

/** Same cost as provisioning.service.ts — one number for the whole codebase. */
const BCRYPT_ROUNDS = 12

const SAFE_USER = {
  id: true, organisationId: true, email: true, fullName: true, status: true,
} as const

/**
 * The link that goes in an email.
 *
 * A FRAGMENT, not a query string. nginx writes query strings into access.log
 * and this is a single-use credential that grants a password set; a fragment
 * is never sent to any server. Same reasoning auth.cookies.ts already gives
 * for keeping the access token out of URLs.
 */
export function setupLink(rawToken: string): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/#setup=${rawToken}`
}

export async function changeOwnName(userId: string, fullName: string) {
  const before = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
  const user = await prisma.user.update({
    where: { id: userId },
    // An explicit object, never a spread of the request body: this is the line
    // that would otherwise let a new field become writable by accident.
    data: { fullName },
    select: SAFE_USER,
  })
  forgetUser(before?.email)
  return user
}

export async function changeOwnPassword(
  userId: string,
  dto: { currentPassword: string; newPassword: string },
  ctx: SessionContext,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, fullName: true, passwordHash: true },
  })
  if (!user) throw new NotFoundError('User')

  // Accounts synced from the driver registry have no password at all. Telling
  // them to check their current password would be a riddle.
  if (!user.passwordHash) {
    throw new BadRequestError('This account has no password set. Use the reset link instead.')
  }

  // 400, NOT 401. A 401 here would be caught by the dashboard's
  // refresh-and-replay, fail again, and sign the user out of the app for
  // mistyping their old password.
  const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash)
  if (!ok) throw new BadRequestError('Current password is incorrect')

  if (dto.currentPassword === dto.newPassword) {
    throw new BadRequestError('The new password must be different from the current one')
  }

  const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS)
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      passwordChangedAt: new Date(),
      // increment, not a read-modify-write: two changes racing would otherwise
      // both read the same count and one would be lost.
      passwordChangeCount: { increment: 1 },
    },
  })

  // Everything else signed in as this person stops working. This is the
  // documented purpose of revokeAllSessions and, until now, its first caller.
  await authService.revokeAllSessions(userId, 'password change')
  // A pending reset link must die with the old password too, or whoever
  // requested it can undo the change.
  await revokeLiveTokens(userId, 'RESET', 'password changed')

  // ...including THIS device, which is why a fresh session is minted straight
  // away. Without it the user is signed out of the tab they are standing in.
  const session = await authService.issueSession({ id: user.id, email: user.email }, ctx)

  await sendMail(
    user.email ?? '',
    user.fullName,
    passwordChangedEmail({ fullName: user.fullName, when: new Date(), ip: ctx.ip ?? undefined }),
  )

  return session
}

/**
 * Ask for a reset link.
 *
 * Answers identically whatever it finds — unknown address, deleted account,
 * suspended account, an account with no email. The only signal is the mail
 * itself. Anything else turns this into a way to ask whether a person has an
 * account here, which is exactly what login already refuses to answer.
 */
export async function requestPasswordReset(
  email: string,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null, status: 'ACTIVE' },
    select: { id: true, email: true, fullName: true },
  })
  if (!user?.email) return

  // Per-account cooldown. IP limiting cannot stop a mail-bomb aimed at one
  // inbox from many sources; this can.
  if (await hasRecentToken(user.id, 'RESET')) return

  const { raw, expiresAt } = await mintPasswordToken(user.id, 'RESET', ctx)
  await sendMail(
    user.email,
    user.fullName,
    resetEmail({ fullName: user.fullName, link: setupLink(raw), expiresAt }),
  )
}

/** What the set-password screen shows before asking for a password. */
export async function describeSetupToken(raw: string) {
  const token = await findLiveToken(raw)
  if (!token) return null
  return {
    fullName: token.user.fullName,
    email: token.user.email,
    purpose: token.purpose,
    expiresAt: token.expiresAt,
  }
}

/** Set the password a link was issued for, and sign the person in. */
export async function completeSetup(raw: string, password: string, ctx: SessionContext) {
  const token = await findLiveToken(raw)
  // One message for expired, consumed, revoked and never-existed: a caller
  // must not be able to tell a used link from a wrong one.
  if (!token) throw new BadRequestError('This link is no longer valid. Ask for a new one.')

  if (token.user.status !== 'ACTIVE') {
    throw new BadRequestError('This account is not active. Contact your administrator.')
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  await consumeToken(token.id, token.userId, passwordHash)

  // Any OTHER pending link for this account is now stale.
  await revokeLiveTokens(token.userId, token.purpose, 'password set')
  // And any session that predates the password being set — accepting an invite
  // should not inherit whatever was signed in before it.
  await authService.revokeAllSessions(token.userId, 'password set')
  forgetUser(token.user.email)

  const session = await authService.issueSession(
    { id: token.user.id, email: token.user.email },
    ctx,
  )
  const user = await prisma.user.findUnique({ where: { id: token.userId }, select: SAFE_USER })
  return { ...session, user }
}

/**
 * Issue an invite for a freshly created account and mail it.
 *
 * Returns WHY it did not send when it did not, because the admin UI has to say
 * so out loud: an invited user whose mail never went has no way into the
 * system at all, and a green tick would hide that completely.
 */
export async function sendInvite(
  user: { id: string; email: string | null; fullName: string },
  orgName: string,
  opts: { roleName?: string | undefined; createdById?: string | null; ip?: string | null },
): Promise<{ sent: boolean; reason?: string }> {
  if (!user.email) return { sent: false, reason: 'no-email' }

  const { raw, expiresAt } = await mintPasswordToken(user.id, 'INVITE', {
    createdById: opts.createdById ?? null,
    ip: opts.ip ?? null,
  })
  const result = await sendMail(
    user.email,
    user.fullName,
    inviteEmail({
      fullName: user.fullName,
      orgName,
      roleName: opts.roleName,
      link: setupLink(raw),
      expiresAt,
    }),
  )
  return result.sent ? { sent: true } : { sent: false, reason: result.reason }
}

/**
 * The devices signed in as this person.
 *
 * Read straight off auth_sessions, which has recorded issuedAt, userAgent and
 * ip since refresh-token rotation was built — none of it was ever shown to
 * anybody. A rotated session is deliberately included while its family is
 * live: rotation happens roughly every fifteen minutes, so hiding rotated rows
 * would show an empty list to somebody who is signed in on three devices.
 * What is excluded is revoked and expired, which are genuinely over.
 */
export async function listOwnSessions(userId: string, currentSid?: string | null) {
  const rows = await prisma.authSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true, familyId: true, issuedAt: true, expiresAt: true,
      rotatedAt: true, userAgent: true, ip: true,
    },
    orderBy: { issuedAt: 'desc' },
  })

  // One row per FAMILY, not per token. A family is a device; the rows within
  // it are that device's rotations, and listing them all would tell somebody
  // they had forty sessions when they have two.
  const byFamily = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const seen = byFamily.get(row.familyId)
    if (!seen || row.issuedAt > seen.issuedAt) byFamily.set(row.familyId, row)
  }

  return [...byFamily.values()].map((row) => ({
    id: row.familyId,
    lastUsedAt: row.rotatedAt ?? row.issuedAt,
    startedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    userAgent: row.userAgent,
    ip: row.ip,
    current: Boolean(currentSid && row.id === currentSid),
  }))
}

/**
 * Sign one device out.
 *
 * Scoped by userId as well as family, so the id in the path cannot be used to
 * revoke somebody else's session — the only identifier this module accepts is
 * the caller's own.
 */
export async function revokeOwnSession(userId: string, familyId: string): Promise<number> {
  const { count } = await prisma.authSession.updateMany({
    where: { userId, familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'signed out by user' },
  })
  if (count === 0) throw new NotFoundError('Session')
  return count
}

/** The organisations this person can reach, and the roles they hold in each. */
export async function listOwnAccess(userId: string) {
  const [memberships, roles] = await Promise.all([
    prisma.orgMembership.findMany({
      where: { userId, revokedAt: null },
      select: {
        organisationId: true,
        allVehicles: true,
        createdAt: true,
        organisation: { select: { id: true, name: true, code: true } },
        _count: { select: { vehicleScopes: true } },
      },
    }),
    prisma.userRole.findMany({
      where: { userId, revokedAt: null },
      select: {
        assignedAt: true,
        role: { select: { id: true, slug: true, name: true, organisationId: true } },
      },
    }),
  ])

  // A platform role has organisationId NULL and applies everywhere, so it is
  // reported on its own rather than pinned to one tenant — saying somebody is
  // a super admin "at Sukari" would misdescribe what the role does.
  const platformRoles = roles
    .filter((r) => r.role.organisationId === null)
    .map((r) => ({ slug: r.role.slug, name: r.role.name, assignedAt: r.assignedAt }))

  const organisations = memberships.map((m) => ({
    id: m.organisation.id,
    name: m.organisation.name,
    code: m.organisation.code,
    joinedAt: m.createdAt,
    allVehicles: m.allVehicles,
    vehicleScopeCount: m._count.vehicleScopes,
    roles: roles
      .filter((r) => r.role.organisationId === m.organisationId)
      .map((r) => ({ slug: r.role.slug, name: r.role.name, assignedAt: r.assignedAt })),
  }))

  return { organisations, platformRoles }
}

/** Created, and the password history the two new columns record. */
export async function getOwnProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, fullName: true, status: true, phone: true,
      createdAt: true, passwordChangedAt: true, passwordChangeCount: true,
      organisation: { select: { id: true, name: true } },
    },
  })
  if (!user) throw new NotFoundError('User')
  return user
}

/** Sign out everywhere. Reuses the auth module's own revocation. */
export async function revokeEverySession(userId: string): Promise<number> {
  return authService.revokeAllSessions(userId, 'signed out of all devices by user')
}
