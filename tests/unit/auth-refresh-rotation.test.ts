/**
 * Refresh-token rotation, and what happens when a token is used twice.
 *
 * Before this, both tokens were stateless JWTs signed with the same secret and
 * distinguished only by a `typ` claim, and `logout` was a comment saying there
 * was nothing to invalidate. A leaked refresh token was therefore good for
 * thirty days, could not be revoked, and left no trace of having been used.
 *
 * The property worth protecting is narrow and worth stating plainly: a stolen
 * refresh token buys at most ONE rotation before the family it belongs to locks
 * itself out and records why.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import * as authService from '../../src/modules/auth/auth.service.js'

const USER = {
  id: 'usr_1',
  organisationId: 'org_a',
  email: 'ops@fleet.dev',
  fullName: 'Ops',
  status: 'ACTIVE' as const,
}

const sha256 = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex')

const future = () => new Date(Date.now() + 86_400_000)
const past   = () => new Date(Date.now() - 1_000)

/** A live, unspent session row. */
const session = (over: Record<string, unknown> = {}) => ({
  id:        'ses_1',
  userId:    USER.id,
  familyId:  'fam_1',
  expiresAt: future(),
  rotatedAt: null,
  revokedAt: null,
  ...over,
})

function arrange(found: unknown, user: unknown = USER) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.authSession.findUnique as any).mockResolvedValue(found)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.user.findFirst as any).mockResolvedValue(user)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.authSession.create as any).mockResolvedValue({ id: 'ses_2' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.authSession.update as any).mockResolvedValue({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.authSession.updateMany as any).mockResolvedValue({ count: 2 })
}

beforeEach(() => { vi.clearAllMocks() })

describe('the refresh token itself', () => {
  it('is looked up by HASH, never stored in the clear', async () => {
    arrange(session())
    await authService.refresh('abc123')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where = (prismaMock.authSession.findUnique as any).mock.calls[0][0].where
    expect(where.tokenHash).toBe(sha256('abc123'))
    expect(JSON.stringify(where)).not.toContain('abc123')
  })

  it('is stored hashed when a new one is issued', async () => {
    arrange(session())
    const out = await authService.refresh('abc123')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (prismaMock.authSession.create as any).mock.calls[0][0].data
    expect(data.tokenHash).toBe(sha256(out.refreshToken))
    expect(data.tokenHash).not.toBe(out.refreshToken)
  })

  it('is not a JWT — nothing about it is readable', async () => {
    arrange(session())
    const out = await authService.refresh('abc123')
    expect(out.refreshToken.split('.')).toHaveLength(1)
  })

  it('is different every time', async () => {
    arrange(session())
    const a = await authService.refresh('abc123')
    arrange(session())
    const b = await authService.refresh('abc123')
    expect(a.refreshToken).not.toBe(b.refreshToken)
  })
})

describe('rotation', () => {
  it('spends the presented token', async () => {
    arrange(session())
    await authService.refresh('abc123')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (prismaMock.authSession.update as any).mock.calls[0][0]
    expect(call.where).toEqual({ id: 'ses_1' })
    expect(call.data.rotatedAt).toBeInstanceOf(Date)
  })

  it('issues the successor into the SAME family', async () => {
    arrange(session({ familyId: 'fam_xyz' }))
    await authService.refresh('abc123')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (prismaMock.authSession.create as any).mock.calls[0][0].data
    expect(data.familyId).toBe('fam_xyz')
    expect(data.userId).toBe(USER.id)
  })

  it('returns a fresh access token carrying the NEW session id', async () => {
    arrange(session())
    const out = await authService.refresh('abc123')

    const claims = JSON.parse(
      Buffer.from(out.accessToken.split('.')[1] as string, 'base64url').toString(),
    ) as { sub: string; sid: string; typ: string }
    expect(claims.sub).toBe(USER.id)
    expect(claims.sid).toBe('ses_2')
    expect(claims.typ).toBe('access')
  })
})

describe('reuse detection', () => {
  it('revokes the WHOLE family when an already-spent token comes back', async () => {
    arrange(session({ rotatedAt: past(), familyId: 'fam_leak' }))

    await expect(authService.refresh('abc123')).rejects.toThrow('Invalid refresh token')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (prismaMock.authSession.updateMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ familyId: 'fam_leak', revokedAt: null })
    expect(call.data.revokedReason).toMatch(/reuse/i)
    expect(call.data.revokedAt).toBeInstanceOf(Date)
  })

  /**
   * The point of revoking the family rather than the row: the honest client's
   * live token is a DESCENDANT of the spent one, so sparing it would leave the
   * thief's next rotation working too.
   */
  it('issues nothing on reuse', async () => {
    arrange(session({ rotatedAt: past() }))
    await expect(authService.refresh('abc123')).rejects.toThrow()
    expect(prismaMock.authSession.create).not.toHaveBeenCalled()
  })

  it('does not even look the account up — the decision is about the token', async () => {
    arrange(session({ rotatedAt: past() }))
    await expect(authService.refresh('abc123')).rejects.toThrow()
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled()
  })
})

describe('tokens that must not work', () => {
  const cases: [string, unknown][] = [
    ['an unknown token',        null],
    ['an already-revoked one',  session({ revokedAt: past() })],
    ['an expired one',          session({ expiresAt: past() })],
  ]

  for (const [label, row] of cases) {
    it(`rejects ${label}`, async () => {
      arrange(row)
      await expect(authService.refresh('abc123')).rejects.toThrow('Invalid refresh token')
      expect(prismaMock.authSession.create).not.toHaveBeenCalled()
    })
  }

  it('rejects an empty token without touching the database', async () => {
    arrange(session())
    await expect(authService.refresh('')).rejects.toThrow('Invalid refresh token')
    expect(prismaMock.authSession.findUnique).not.toHaveBeenCalled()
  })

  /** Every failure says the same thing, so nothing is learned by probing. */
  it('gives one message for every reason', async () => {
    const messages: string[] = []
    for (const [, row] of cases) {
      arrange(row)
      await authService.refresh('abc123').catch((e: Error) => messages.push(e.message))
    }
    expect(new Set(messages).size).toBe(1)
  })
})

describe('the account is re-checked on every refresh', () => {
  it('refuses a suspended account holding a perfectly good token', async () => {
    arrange(session(), { ...USER, status: 'SUSPENDED' })
    await expect(authService.refresh('abc123')).rejects.toThrow(/suspended/i)
    expect(prismaMock.authSession.create).not.toHaveBeenCalled()
  })

  it('refuses a soft-deleted account', async () => {
    arrange(session(), null)
    await expect(authService.refresh('abc123')).rejects.toThrow('Invalid refresh token')
  })

  it('only ever considers accounts that are not deleted', async () => {
    arrange(session())
    await authService.refresh('abc123')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.user.findFirst as any).mock.calls[0][0].where)
      .toEqual({ id: USER.id, deletedAt: null })
  })
})

describe('logout', () => {
  it('revokes the whole family, not just the presented row', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.findUnique as any).mockResolvedValue({ familyId: 'fam_1' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.updateMany as any).mockResolvedValue({ count: 1 })

    await authService.logout('abc123')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (prismaMock.authSession.updateMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ familyId: 'fam_1', revokedAt: null })
    expect(call.data.revokedReason).toBe('logout')
  })

  it('is silent about a token it does not recognise', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.findUnique as any).mockResolvedValue(null)
    await expect(authService.logout('nonsense')).resolves.toBeUndefined()
    expect(prismaMock.authSession.updateMany).not.toHaveBeenCalled()
  })

  it('does nothing at all with no token', async () => {
    await expect(authService.logout(undefined)).resolves.toBeUndefined()
    expect(prismaMock.authSession.findUnique).not.toHaveBeenCalled()
  })
})

describe('revokeAllSessions', () => {
  it('signs every device out and says how many', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.authSession.updateMany as any).mockResolvedValue({ count: 3 })
    const n = await authService.revokeAllSessions(USER.id, 'password reset')
    expect(n).toBe(3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (prismaMock.authSession.updateMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ userId: USER.id, revokedAt: null })
    expect(call.data.revokedReason).toBe('password reset')
  })
})
