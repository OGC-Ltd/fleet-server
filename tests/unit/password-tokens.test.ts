/**
 * Password-token lifecycle.
 *
 * The property that matters most is the first one: what we hand the user and
 * what we store must never be the same string. Everything else here defends
 * single-use — a link that still works after it has been used, expired or
 * superseded is the whole risk this table carries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => null,
  getQueueRedis: () => null,
  isRedisConfigured: () => false,
  CACHE_DB: 0, QUEUE_DB: 1,
  disconnectRedis: async () => {},
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import {
  mintPasswordToken, findLiveToken, consumeToken, revokeLiveTokens, hasRecentToken,
} from '../../src/modules/account/tokens.service.js'

const sha256 = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex')

beforeEach(() => { vi.clearAllMocks() })

describe('mintPasswordToken', () => {
  it('stores the HASH and returns the raw token — they are never the same', async () => {
    prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.passwordToken.create.mockResolvedValue({} as never)

    const { raw } = await mintPasswordToken('u1', 'INVITE')

    const written = prismaMock.passwordToken.create.mock.calls[0]![0].data as { tokenHash: string }
    expect(written.tokenHash).not.toBe(raw)
    expect(written.tokenHash).toBe(sha256(raw))
    // 32 bytes of base64url — long enough that the GET route can 404 freely
    // without becoming an enumeration oracle.
    expect(raw.length).toBeGreaterThanOrEqual(40)
  })

  it('revokes any live token of the same purpose before issuing a new one', async () => {
    prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.passwordToken.create.mockResolvedValue({} as never)

    await mintPasswordToken('u1', 'INVITE')

    expect(prismaMock.passwordToken.updateMany).toHaveBeenCalledBefore(
      prismaMock.passwordToken.create as never,
    )
    const where = prismaMock.passwordToken.updateMany.mock.calls[0]![0].where as Record<string, unknown>
    expect(where).toMatchObject({ userId: 'u1', purpose: 'INVITE', consumedAt: null, revokedAt: null })
  })

  it('gives an invite a longer life than a reset', async () => {
    prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.passwordToken.create.mockResolvedValue({} as never)

    const invite = await mintPasswordToken('u1', 'INVITE')
    const reset = await mintPasswordToken('u1', 'RESET')

    expect(invite.expiresAt.getTime()).toBeGreaterThan(reset.expiresAt.getTime())
  })

  it('records who issued it, for an invite', async () => {
    prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.passwordToken.create.mockResolvedValue({} as never)

    await mintPasswordToken('u1', 'INVITE', { createdById: 'admin-1', ip: '10.0.0.9' })

    expect(prismaMock.passwordToken.create.mock.calls[0]![0].data).toMatchObject({
      createdById: 'admin-1', requestedIp: '10.0.0.9',
    })
  })
})

describe('findLiveToken', () => {
  it('looks up by hash, never by the raw value', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)
    await findLiveToken('some-raw-token')

    const where = (prismaMock.passwordToken.findFirst.mock.calls[0]![0]!).where as Record<string, unknown>
    expect(where['tokenHash']).toBe(sha256('some-raw-token'))
    expect(JSON.stringify(where)).not.toContain('some-raw-token')
  })

  it('requires unconsumed, unrevoked and unexpired in the query itself', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)
    await findLiveToken('t')

    const where = (prismaMock.passwordToken.findFirst.mock.calls[0]![0]!).where as Record<string, unknown>
    expect(where['consumedAt']).toBeNull()
    expect(where['revokedAt']).toBeNull()
    expect(where['expiresAt']).toMatchObject({ gt: expect.any(Date) })
  })

  it('returns null for an empty token without touching the database', async () => {
    await expect(findLiveToken('')).resolves.toBeNull()
    expect(prismaMock.passwordToken.findFirst).not.toHaveBeenCalled()
  })
})

describe('consumeToken', () => {
  it('writes the password and burns the token in ONE transaction', async () => {
    prismaMock.$transaction.mockResolvedValue([] as never)
    await consumeToken('tok-1', 'u1', 'new-hash')

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // Both operations, together — a password set without the token consumed
    // leaves a live link that can set it again.
    const ops = prismaMock.$transaction.mock.calls[0]![0] as unknown as unknown[]
    // Three: the password, this token, and every OTHER live link to the
    // account — see the sibling-revocation test below.
    expect(ops).toHaveLength(3)
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        // Setting a password from a link counts as a change like any other —
        // otherwise an invited account reads as never having had one set.
        data: expect.objectContaining({
          passwordHash: 'new-hash',
          passwordChangedAt: expect.any(Date),
          passwordChangeCount: { increment: 1 },
        }),
      }),
    )
    expect(prismaMock.passwordToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tok-1' } }),
    )
  })

  /**
   * An account takeover, found on a live account.
   *
   * `mintPasswordToken` only revokes tokens of the SAME purpose, so an invited
   * user who gave up on their invite and pressed "forgot password" ends up
   * holding two live links. Consuming only the reset left the INVITE valid —
   * and `findLiveToken` matches on the hash without ever looking at the purpose
   * — so the original invitation email still set the password of an account
   * that by then had a person using it.
   */
  it('revokes every OTHER live link to the account, not just the one used', async () => {
    prismaMock.$transaction.mockResolvedValue([] as never)
    await consumeToken('tok-reset', 'u1', 'new-hash')

    expect(prismaMock.passwordToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId:     'u1',
          // Every purpose, not just this one. An INVITE left live behind a
          // consumed RESET is the exact case this exists for.
          id:         { not: 'tok-reset' },
          consumedAt: null,
          revokedAt:  null,
        }),
        data: expect.objectContaining({
          revokedAt:     expect.any(Date),
          revokedReason: expect.any(String),
        }),
      }),
    )
  })

  it('revokes them in the SAME transaction as the password write', async () => {
    // Outside it, a crash between the two leaves the old link live against the
    // new password — which is the whole failure, merely narrower.
    prismaMock.$transaction.mockResolvedValue([] as never)
    await consumeToken('tok-1', 'u1', 'new-hash')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.passwordToken.updateMany).toHaveBeenCalledTimes(1)
  })
})

describe('revokeLiveTokens / hasRecentToken', () => {
  it('revocation records a reason', async () => {
    prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 2 } as never)
    await expect(revokeLiveTokens('u1', 'RESET', 'password changed')).resolves.toBe(2)
    expect(prismaMock.passwordToken.updateMany.mock.calls[0]![0].data).toMatchObject({
      revokedReason: 'password changed',
    })
  })

  it('reports a recent request, which is what stops mail-bombing one address', async () => {
    prismaMock.passwordToken.findFirst.mockResolvedValue({ id: 'x' } as never)
    await expect(hasRecentToken('u1', 'RESET')).resolves.toBe(true)

    prismaMock.passwordToken.findFirst.mockResolvedValue(null as never)
    await expect(hasRecentToken('u1', 'RESET')).resolves.toBe(false)
  })
})
