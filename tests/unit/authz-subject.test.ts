/**
 * Resolving a person into "what may you do, and which vehicles may you see".
 *
 * Redis is mocked away entirely, so every case here exercises the Postgres
 * path. That is the fallback the design leans on — the cache client runs with
 * `enableOfflineQueue: false` and throws rather than blocking when Redis is
 * unreachable — and a fallback nothing tests is a fallback that fails open the
 * first time it is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
// No Redis: resolveSubject must answer from the database alone.
vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => null,
  getQueueRedis: () => null,
  isRedisConfigured: () => false,
  CACHE_DB: 0,
  QUEUE_DB: 1,
  disconnectRedis: async () => {},
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import {
  resolveSubject, can, canReachOrg, permissionsIn, vehicleScopeIn,
} from '../../src/lib/authz/subject.js'

const ORG_A = 'org_a'
const ORG_B = 'org_b'

type Grant = { role: { organisationId: string | null; permissions: { permission: { slug: string } }[] } }

const grant = (organisationId: string | null, ...slugs: string[]): Grant => ({
  role: { organisationId, permissions: slugs.map((slug) => ({ permission: { slug } })) },
})

const membership = (
  organisationId: string,
  allVehicles = true,
  vehicleScopes: { vehicleId: string | null; vehicleGroupId: string | null }[] = [],
) => ({ organisationId, allVehicles, vehicleScopes })

function setup(memberships: unknown[], grants: unknown[], groupMembers: unknown[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.orgMembership.findMany as any).mockResolvedValue(memberships)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.userRole.findMany as any).mockResolvedValue(grants)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.vehicle.findMany as any).mockResolvedValue(groupMembers)
}

beforeEach(() => { vi.clearAllMocks() })

describe('one organisation, one role', () => {
  beforeEach(() => setup([membership(ORG_A)], [grant(ORG_A, 'map:read', 'telemetry:read')]))

  it('holds its permissions in that organisation', async () => {
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'map:read')).toBe(true)
    expect(can(s, ORG_A, 'analytics:read')).toBe(false)
  })

  it('holds nothing in an organisation it is not a member of', async () => {
    const s = await resolveSubject('u1')
    expect(canReachOrg(s, ORG_B)).toBe(false)
    expect(can(s, ORG_B, 'map:read')).toBe(false)
  })

  it('sees the whole fleet when the membership is not narrowed', async () => {
    const s = await resolveSubject('u1')
    expect(vehicleScopeIn(s, ORG_A)).toBeNull()
  })
})

describe('one person, two organisations, a different role in each', () => {
  beforeEach(() =>
    setup(
      [membership(ORG_A), membership(ORG_B)],
      [
        grant(ORG_A, 'map:read', 'analytics:read', 'report:export'),
        grant(ORG_B, 'map:read'),
      ],
    ))

  it('reaches both', async () => {
    const s = await resolveSubject('u1')
    expect(canReachOrg(s, ORG_A)).toBe(true)
    expect(canReachOrg(s, ORG_B)).toBe(true)
  })

  /** The requirement in one assertion: rights are per organisation, not global. */
  it('does not carry a permission from one organisation into the other', async () => {
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'report:export')).toBe(true)
    expect(can(s, ORG_B, 'report:export')).toBe(false)
  })

  it('merges nothing across organisations when asked for one', async () => {
    const s = await resolveSubject('u1')
    expect([...permissionsIn(s, ORG_B)].sort()).toEqual(['map:read'])
  })
})

describe('platform roles', () => {
  beforeEach(() => setup([], [grant(null, 'platform:read_all', 'analytics:read')]))

  it('reach an organisation with no membership row at all', async () => {
    const s = await resolveSubject('u1')
    expect(s.isPlatform).toBe(true)
    expect(canReachOrg(s, ORG_A)).toBe(true)
    expect(canReachOrg(s, 'org_never_seen')).toBe(true)
  })

  it('apply their permissions in every organisation', async () => {
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'analytics:read')).toBe(true)
    expect(can(s, ORG_B, 'analytics:read')).toBe(true)
  })

  it('still cannot do what they were never granted', async () => {
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'user:create')).toBe(false)
  })

  it('see the whole fleet, since there is no membership to narrow', async () => {
    const s = await resolveSubject('u1')
    expect(vehicleScopeIn(s, ORG_A)).toBeNull()
  })
})

describe('the wildcard', () => {
  it('satisfies anything, in any organisation', async () => {
    setup([], [grant(null, 'platform:admin')])
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'user:delete')).toBe(true)
    expect(can(s, ORG_B, 'organisation:create')).toBe(true)
    expect(can(s, null, 'organisation:create')).toBe(true)
  })
})

describe('vehicle scope', () => {
  it('narrows to the named vehicles', async () => {
    setup(
      [membership(ORG_A, false, [
        { vehicleId: 'v1', vehicleGroupId: null },
        { vehicleId: 'v2', vehicleGroupId: null },
      ])],
      [grant(ORG_A, 'map:read')],
    )
    const s = await resolveSubject('u1')
    expect([...(vehicleScopeIn(s, ORG_A) ?? [])].sort()).toEqual(['v1', 'v2'])
  })

  it('expands a group to its members', async () => {
    setup(
      [membership(ORG_A, false, [{ vehicleId: null, vehicleGroupId: 'g1' }])],
      [grant(ORG_A, 'map:read')],
      [
        { id: 'v10', vehicleGroupId: 'g1' },
        { id: 'v11', vehicleGroupId: 'g1' },
      ],
    )
    const s = await resolveSubject('u1')
    expect([...(vehicleScopeIn(s, ORG_A) ?? [])].sort()).toEqual(['v10', 'v11'])
  })

  it('unions individual vehicles with group members, without duplicating', async () => {
    setup(
      [membership(ORG_A, false, [
        { vehicleId: 'v10', vehicleGroupId: null },
        { vehicleId: null, vehicleGroupId: 'g1' },
      ])],
      [grant(ORG_A, 'map:read')],
      [
        { id: 'v10', vehicleGroupId: 'g1' },   // already named individually
        { id: 'v11', vehicleGroupId: 'g1' },
      ],
    )
    const s = await resolveSubject('u1')
    expect([...(vehicleScopeIn(s, ORG_A) ?? [])].sort()).toEqual(['v10', 'v11'])
  })

  /**
   * The distinction the whole design rests on. `null` is "no restriction";
   * an EMPTY SET is "nothing". Confusing them either blanks the map for every
   * ordinary user or hands a scoped operator the entire fleet.
   */
  it('answers an empty set — not null — for a membership narrowed to nothing', async () => {
    setup([membership(ORG_A, false, [])], [grant(ORG_A, 'map:read')])
    const s = await resolveSubject('u1')
    const scope = vehicleScopeIn(s, ORG_A)
    expect(scope).not.toBeNull()
    expect(scope?.size).toBe(0)
  })

  it('answers an empty set for an organisation the subject cannot reach', async () => {
    setup([membership(ORG_A)], [grant(ORG_A, 'map:read')])
    const s = await resolveSubject('u1')
    expect(vehicleScopeIn(s, ORG_B)?.size).toBe(0)
  })

  it('does not query vehicles at all when no group is scoped', async () => {
    setup([membership(ORG_A)], [grant(ORG_A, 'map:read')])
    await resolveSubject('u1')
    expect(prismaMock.vehicle.findMany).not.toHaveBeenCalled()
  })
})

describe('membership and roles are separate questions', () => {
  it('a membership with no role reaches the organisation and can do nothing', async () => {
    setup([membership(ORG_A)], [])
    const s = await resolveSubject('u1')
    expect(canReachOrg(s, ORG_A)).toBe(true)
    expect(permissionsIn(s, ORG_A).size).toBe(0)
    expect(can(s, ORG_A, 'map:read')).toBe(false)
  })

  /**
   * A role granted for an organisation the user is not a member of confers
   * nothing — revoking membership is enough to cut access off, without having
   * to hunt down every grant.
   */
  it('an org role without a membership confers nothing', async () => {
    setup([], [grant(ORG_A, 'map:read', 'analytics:read')])
    const s = await resolveSubject('u1')
    expect(s.isPlatform).toBe(false)
    expect(canReachOrg(s, ORG_A)).toBe(false)
    expect(can(s, ORG_A, 'map:read')).toBe(false)
  })
})

describe('several roles in one organisation', () => {
  it('unions their permissions', async () => {
    setup(
      [membership(ORG_A)],
      [grant(ORG_A, 'map:read'), grant(ORG_A, 'analytics:read', 'map:read')],
    )
    const s = await resolveSubject('u1')
    expect([...permissionsIn(s, ORG_A)].sort()).toEqual(['analytics:read', 'map:read'])
  })
})

describe('only live grants count', () => {
  it('asks Postgres for non-revoked memberships and non-revoked roles', async () => {
    setup([membership(ORG_A)], [grant(ORG_A, 'map:read')])
    await resolveSubject('u1')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.orgMembership.findMany as any).mock.calls[0][0].where)
      .toEqual({ userId: 'u1', revokedAt: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.userRole.findMany as any).mock.calls[0][0].where)
      .toEqual({ userId: 'u1', revokedAt: null })
  })
})
