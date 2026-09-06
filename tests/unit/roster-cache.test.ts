/**
 * The roster cache, and the one property that makes it safe to have.
 *
 * A cache in front of an administration page is only acceptable if a write is
 * visible immediately afterwards. Every other quality — hit rate, TTL, key
 * shape — is an optimisation. This one is correctness: an admin who suspends
 * an account and is then shown ACTIVE will suspend it again, and an admin who
 * grants a role and does not see it will grant it twice.
 *
 * So the tests here are mostly about invalidation, and about the fallback,
 * because Redis is optional in this deployment and the page must work without
 * it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** A Redis stand-in: a Map, plus the three calls this module makes. */
const store = new Map<string, string>()
const redis = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' }),
  pipeline: vi.fn(() => {
    const ops: string[] = []
    return {
      incr: (k: string) => { ops.push(k); return undefined },
      exec: async () => {
        for (const k of ops) store.set(k, String(Number(store.get(k) ?? '0') + 1))
        return []
      },
    }
  }),
}

let present = true
vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => (present ? redis : null),
}))
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const findUnique  = vi.fn()
const transaction = vi.fn(async () => [[], 0])
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findMany:   vi.fn(),
      count:      vi.fn(),
    },
    $transaction: (...a: unknown[]) => transaction(...(a as [])),
  },
}))

import {
  readRoster, writeRoster, invalidateRoster, invalidateRosterForUser,
} from '../../src/modules/users/roster.cache.js'
import { listUsers } from '../../src/modules/users/user.service.js'
import type { ListUserQuery } from '../../src/modules/users/user.schema.js'

const ORG_A = 'org_a'
const ORG_B = 'org_b'
const VARIANT = '1:100:all:system'

beforeEach(() => {
  store.clear()
  present = true
  vi.clearAllMocks()
  findUnique.mockResolvedValue({ organisationId: ORG_A, memberships: [] })
  transaction.mockResolvedValue([[], 0])
})

describe('reading and writing', () => {
  it('returns what was written, for the same organisation and variant', async () => {
    await writeRoster(ORG_A, VARIANT, { data: [{ id: 'u1' }], total: 1 })
    await expect(readRoster(ORG_A, VARIANT)).resolves.toEqual({ data: [{ id: 'u1' }], total: 1 })
  })

  it('misses when the variant differs — a different page is a different answer', async () => {
    await writeRoster(ORG_A, '1:100:all:system', { data: [], total: 0 })
    await expect(readRoster(ORG_A, '2:100:all:system')).resolves.toBeNull()
    await expect(readRoster(ORG_A, '1:100:SUSPENDED:system')).resolves.toBeNull()
  })

  it('never serves one organisation from another', async () => {
    await writeRoster(ORG_A, VARIANT, { data: [{ id: 'a' }], total: 1 })
    await expect(readRoster(ORG_B, VARIANT)).resolves.toBeNull()
  })

  it('sets a TTL, so a lost invalidation expires rather than persisting', async () => {
    await writeRoster(ORG_A, VARIANT, { data: [], total: 0 })
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', expect.any(Number))
  })
})

describe('invalidation — the property that makes the cache safe', () => {
  it('a bump makes the previous entry unreachable', async () => {
    await writeRoster(ORG_A, VARIANT, { data: [{ id: 'u1' }], total: 1 })
    await invalidateRoster(ORG_A)
    await expect(readRoster(ORG_A, VARIANT)).resolves.toBeNull()
  })

  it('leaves other organisations alone', async () => {
    await writeRoster(ORG_A, VARIANT, { data: [], total: 0 })
    await writeRoster(ORG_B, VARIANT, { data: [{ id: 'b' }], total: 1 })
    await invalidateRoster(ORG_A)
    await expect(readRoster(ORG_B, VARIANT)).resolves.toEqual({ data: [{ id: 'b' }], total: 1 })
  })

  it('retires every roster a person appears in, not just their employer', async () => {
    // The multi-organisation case: suspending somebody who works at three
    // sites changes what all three administrators see.
    findUnique.mockResolvedValue({
      organisationId: ORG_A,
      memberships: [{ organisationId: ORG_B }, { organisationId: 'org_c' }],
    })
    await writeRoster(ORG_A, VARIANT, { data: [], total: 0 })
    await writeRoster(ORG_B, VARIANT, { data: [], total: 0 })
    await writeRoster('org_c', VARIANT, { data: [], total: 0 })

    await invalidateRosterForUser('u1')

    for (const org of [ORG_A, ORG_B, 'org_c']) {
      await expect(readRoster(org, VARIANT)).resolves.toBeNull()
    }
  })

  it('retires an organisation named explicitly even when the user is not in it yet', async () => {
    // Granting a NEW membership: at the moment of the call the person does not
    // resolve to the organisation they are about to appear in.
    findUnique.mockResolvedValue({ organisationId: ORG_A, memberships: [] })
    await writeRoster(ORG_B, VARIANT, { data: [], total: 0 })

    await invalidateRosterForUser('u1', ORG_B)

    await expect(readRoster(ORG_B, VARIANT)).resolves.toBeNull()
  })

  it('does not throw when the write path cannot resolve the user', async () => {
    // The write it followed already succeeded. Failing now would turn a
    // change that worked into an error the admin has to interpret.
    findUnique.mockRejectedValue(new Error('connection lost'))
    await expect(invalidateRosterForUser('u1', ORG_A)).resolves.toBeUndefined()
  })
})

describe('without Redis', () => {
  it('reads miss, writes are no-ops, and nothing throws', async () => {
    present = false
    await expect(writeRoster(ORG_A, VARIANT, { data: [], total: 0 })).resolves.toBeUndefined()
    await expect(readRoster(ORG_A, VARIANT)).resolves.toBeNull()
    await expect(invalidateRoster(ORG_A)).resolves.toBeUndefined()
  })

  it('survives a Redis that is present but failing', async () => {
    redis.get.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(readRoster(ORG_A, VARIANT)).resolves.toBeNull()
  })
})

describe('listUsers — the database is read once, then the cache answers', () => {
  const QUERY = { page: 1, limit: 100, access: 'system' } as unknown as ListUserQuery

  it('goes to the database on the first call and not on the second', async () => {
    await listUsers(ORG_A, QUERY)
    expect(transaction).toHaveBeenCalledTimes(1)

    await listUsers(ORG_A, QUERY)
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('goes back to the database after a write invalidates the organisation', async () => {
    await listUsers(ORG_A, QUERY)
    await invalidateRoster(ORG_A)
    await listUsers(ORG_A, QUERY)

    // The whole point: an administrator who has just changed something is not
    // shown the answer from before they changed it.
    expect(transaction).toHaveBeenCalledTimes(2)
  })

  it('reads the database every time when Redis is absent', async () => {
    present = false
    await listUsers(ORG_A, QUERY)
    await listUsers(ORG_A, QUERY)
    expect(transaction).toHaveBeenCalledTimes(2)
  })
})
