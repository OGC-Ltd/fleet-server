/**
 * Self-service account changes.
 *
 * Three things are pinned here, and each of them is a way the feature could be
 * quietly wrong rather than visibly broken:
 *
 *   1. A wrong current password must throw a 400 — NOT a 401. The dashboard
 *      retries a 401 through its refresh path, fails again, and signs the user
 *      out. Mistyping your old password must not log you out of the app.
 *   2. Changing your name must touch `fullName` and nothing else. The schema
 *      is the first gate; this asserts the service does not widen it.
 *   3. Changing a password must revoke every existing session, and then hand
 *      back a new one so the tab you are standing in survives.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => null,
  getQueueRedis: () => null,
  isRedisConfigured: () => false,
  CACHE_DB: 0, QUEUE_DB: 1,
  disconnectRedis: async () => {},
}))
// bcrypt at 12 rounds is ~250ms a call and proves nothing here.
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn(async () => '$2a$new-hash'),
    compare: vi.fn(async (plain: string) => plain === 'correct-horse-battery'),
  },
}))
vi.mock('../../src/lib/mailer/mailer.js', () => ({
  sendMail: vi.fn(async () => ({ sent: true })),
}))

const revokeAllSessions = vi.fn(async () => 3)
const issueSession = vi.fn(async () => ({
  accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 900,
}))
vi.mock('../../src/modules/auth/auth.service.js', () => ({
  revokeAllSessions: (...args: unknown[]) => revokeAllSessions(...(args as [])),
  issueSession: (...args: unknown[]) => issueSession(...(args as [])),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import * as account from '../../src/modules/account/account.service.js'
import { sendMail } from '../../src/lib/mailer/mailer.js'

const CTX = { ip: '10.0.0.1', userAgent: 'vitest' }

const USER = {
  id: 'u1',
  email: 'maya@example.test',
  fullName: 'Maya Okonkwo',
  passwordHash: '$2a$existing',
}

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 0 } as never)
  prismaMock.passwordToken.create.mockResolvedValue({} as never)
})

describe('changeOwnPassword', () => {
  it('refuses a wrong current password WITHOUT writing anything', async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER as never)

    await expect(account.changeOwnPassword('u1', {
      currentPassword: 'wrong', newPassword: 'a-brand-new-passphrase',
    }, CTX)).rejects.toThrow(/current password is incorrect/i)

    expect(prismaMock.user.update).not.toHaveBeenCalled()
    expect(revokeAllSessions).not.toHaveBeenCalled()
  })

  it('throws a 400, not a 401 — a 401 would sign the user out of the app', async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER as never)

    await expect(account.changeOwnPassword('u1', {
      currentPassword: 'wrong', newPassword: 'a-brand-new-passphrase',
    }, CTX)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses when the account has no password at all', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...USER, passwordHash: null } as never)

    await expect(account.changeOwnPassword('u1', {
      currentPassword: 'anything', newPassword: 'a-brand-new-passphrase',
    }, CTX)).rejects.toThrow(/no password set/i)
  })

  it('refuses a new password identical to the current one', async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER as never)

    await expect(account.changeOwnPassword('u1', {
      currentPassword: 'correct-horse-battery', newPassword: 'correct-horse-battery',
    }, CTX)).rejects.toThrow(/must be different/i)

    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })

  it('writes the hash, revokes every session, then issues a fresh one', async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER as never)
    prismaMock.user.update.mockResolvedValue(USER as never)

    const session = await account.changeOwnPassword('u1', {
      currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-passphrase',
    }, CTX)

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          passwordHash: '$2a$new-hash',
          passwordChangedAt: expect.any(Date),
          // An increment, not a read-modify-write: two changes racing would
          // otherwise both read the same count and one would be lost.
          passwordChangeCount: { increment: 1 },
        }),
      }),
    )
    expect(revokeAllSessions).toHaveBeenCalledWith('u1', 'password change')
    // The replacement session is what keeps the CURRENT tab signed in after
    // its own session was revoked a line earlier.
    expect(issueSession).toHaveBeenCalled()
    expect(session.accessToken).toBe('new-access')
  })

  it('kills any pending reset link, so it cannot undo the change', async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER as never)
    prismaMock.user.update.mockResolvedValue(USER as never)

    await account.changeOwnPassword('u1', {
      currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-passphrase',
    }, CTX)

    expect(prismaMock.passwordToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', purpose: 'RESET' }),
      }),
    )
  })

  it('notifies the account owner', async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER as never)
    prismaMock.user.update.mockResolvedValue(USER as never)

    await account.changeOwnPassword('u1', {
      currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-passphrase',
    }, CTX)

    expect(sendMail).toHaveBeenCalledWith(
      'maya@example.test', 'Maya Okonkwo',
      expect.objectContaining({ category: 'password-changed' }),
    )
  })
})

describe('changeOwnName', () => {
  it('writes fullName and NOTHING else', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ email: 'maya@example.test' } as never)
    prismaMock.user.update.mockResolvedValue({ id: 'u1', fullName: 'Maya O' } as never)

    await account.changeOwnName('u1', 'Maya O')

    const call = prismaMock.user.update.mock.calls[0]![0]!
    // The exact object, not a subset: this is the assertion that fails if
    // somebody ever spreads the request body in here.
    expect(call.data).toEqual({ fullName: 'Maya O' })
    expect(Object.keys(call.data as object)).toEqual(['fullName'])
  })

  it('never touches the fields a user must not change', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ email: 'maya@example.test' } as never)
    prismaMock.user.update.mockResolvedValue({ id: 'u1' } as never)

    await account.changeOwnName('u1', 'Maya O')

    const data = prismaMock.user.update.mock.calls[0]![0]!.data as Record<string, unknown>
    for (const forbidden of ['email', 'passwordHash', 'status', 'organisationId', 'deletedAt']) {
      expect(data[forbidden]).toBeUndefined()
    }
  })
})

describe('requestPasswordReset', () => {
  it('does nothing at all for an unknown address', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null as never)

    await expect(account.requestPasswordReset('nobody@example.test', CTX)).resolves.toBeUndefined()

    expect(prismaMock.passwordToken.create).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('mints a RESET token and mails it for a real account', async () => {
    prismaMock.user.findFirst.mockResolvedValue(USER as never)
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never) // no cooldown

    await account.requestPasswordReset('maya@example.test', CTX)

    expect(prismaMock.passwordToken.create).toHaveBeenCalled()
    expect(sendMail).toHaveBeenCalledWith(
      'maya@example.test', 'Maya Okonkwo',
      expect.objectContaining({ category: 'password-reset' }),
    )
  })

  it('stays silent when one was just sent — an IP limit cannot stop a mail-bomb at one inbox', async () => {
    prismaMock.user.findFirst.mockResolvedValue(USER as never)
    prismaMock.passwordToken.findFirst.mockResolvedValue({ id: 'recent' } as never)

    await account.requestPasswordReset('maya@example.test', CTX)

    expect(prismaMock.passwordToken.create).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })
})

describe('sendPasswordReset — from the user page', () => {
  it('mints a RESET token, mails it, and says it went', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)

    const out = await account.sendPasswordReset(USER, { createdById: 'admin-1', ip: '10.0.0.2' })

    expect(out).toEqual({ sent: true })
    expect(prismaMock.passwordToken.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u1', purpose: 'RESET', createdById: 'admin-1' }),
    }))
    expect(sendMail).toHaveBeenCalledWith(
      'maya@example.test', 'Maya Okonkwo',
      expect.objectContaining({ category: 'password-reset' }),
    )
  })

  it('says why when it sends nothing', async () => {
    await expect(account.sendPasswordReset({ ...USER, email: null }, {})).resolves.toEqual({ sent: false, reason: 'no-email' })

    prismaMock.passwordToken.findFirst.mockResolvedValue({ id: 'recent' } as never)
    await expect(account.sendPasswordReset(USER, {})).resolves.toEqual({ sent: false, reason: 'recently-sent' })

    expect(prismaMock.passwordToken.create).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })
})

describe('completeSetup', () => {
  it('refuses a link that is not live, without saying which kind of dead it is', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)

    await expect(account.completeSetup('gone', 'a-brand-new-passphrase', CTX))
      .rejects.toThrow(/no longer valid/i)

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('refuses a suspended account even with a valid link', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue({
      id: 't1', userId: 'u1', purpose: 'INVITE', expiresAt: new Date(Date.now() + 1000),
      user: { ...USER, status: 'SUSPENDED' },
    } as never)

    await expect(account.completeSetup('tok', 'a-brand-new-passphrase', CTX))
      .rejects.toThrow(/not active/i)
  })

  it('sets the password and signs the person straight in', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue({
      id: 't1', userId: 'u1', purpose: 'INVITE', expiresAt: new Date(Date.now() + 1000),
      user: { ...USER, status: 'ACTIVE' },
    } as never)
    prismaMock.$transaction.mockResolvedValue([] as never)
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', fullName: 'Maya Okonkwo' } as never)

    const out = await account.completeSetup('tok', 'a-brand-new-passphrase', CTX)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(revokeAllSessions).toHaveBeenCalledWith('u1', 'password set')
    expect(out.accessToken).toBe('new-access')
  })
})

// Operator, 2026-10-09: kept in the browser, the first-time tour came back on
// every other machine a person signed in on.
describe('recordTourSeen', () => {
  it('records the version on the account, and only raises it', async () => {
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.user.findUnique.mockResolvedValue({ tourSeenVersion: 2 } as never)

    const out = await account.recordTourSeen('u1', 2)

    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', OR: [{ tourSeenVersion: null }, { tourSeenVersion: { lt: 2 } }] },
      data:  { tourSeenVersion: 2 },
    })
    expect(out).toEqual({ tourSeenVersion: 2 })
  })

  it('answers with what the account holds when a newer tour was already seen', async () => {
    prismaMock.user.updateMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.user.findUnique.mockResolvedValue({ tourSeenVersion: 3 } as never)

    expect(await account.recordTourSeen('u1', 1)).toEqual({ tourSeenVersion: 3 })
  })

  it('reads never-shown as null', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ tourSeenVersion: null } as never)
    expect(await account.tourSeenVersion('u1')).toBeNull()
  })
})
