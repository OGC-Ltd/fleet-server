/**
 * Creating people and granting them access.
 *
 * The rule these exist to protect: an organisation admin may create users FOR
 * THAT ORGANISATION and nowhere else. Everything else here is about not letting
 * a caller write a scope that means something other than what they asked for —
 * ids from another tenant, an empty restriction, a platform role handed out
 * through a tenant-level endpoint.
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
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => '$2a$hashed'), compare: vi.fn(async () => true) } }))

import { prismaMock } from '../helpers/prisma.mock.js'
import * as provisioning from '../../src/modules/users/provisioning.service.js'

const ORG_A = 'org_a'
const ORG_B = 'org_b'

/** Happy-path doubles; individual tests narrow what they care about. */
function arrange(over: Record<string, unknown> = {}) {
  const m = prismaMock as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
  m['organisation']!['findUnique']!.mockResolvedValue({ id: ORG_A })
  m['user']!['findFirst']!.mockResolvedValue(null)
  m['user']!['create']!.mockResolvedValue({ id: 'usr_new' })
  m['user']!['findUnique']!.mockResolvedValue({ id: 'usr_new', email: 'a@b.c', fullName: 'A', status: 'ACTIVE' })
  m['user']!['update']!.mockResolvedValue({ id: 'usr_new' })
  m['vehicle']!['count']!.mockResolvedValue(0)
  m['vehicleGroup']!['count']!.mockResolvedValue(0)
  m['role']!['findMany']!.mockResolvedValue([])
  m['orgMembership']!['upsert']!.mockResolvedValue({ id: 'mem_1' })
  m['orgMembership']!['findMany']!.mockResolvedValue([])
  m['orgMembership']!['findUnique']!.mockResolvedValue({ id: 'mem_1', revokedAt: null })
  m['orgMembership']!['update']!.mockResolvedValue({})
  m['membershipVehicleScope']!['deleteMany']!.mockResolvedValue({ count: 0 })
  m['membershipVehicleScope']!['createMany']!.mockResolvedValue({ count: 0 })
  m['userRole']!['findMany']!.mockResolvedValue([])
  m['userRole']!['create']!.mockResolvedValue({})
  m['userRole']!['updateMany']!.mockResolvedValue({ count: 0 })
  for (const [k, v] of Object.entries(over)) {
    const [model, fn] = k.split('.') as [string, string]
    m[model]![fn]!.mockResolvedValue(v)
  }
}

const dto = (over: Record<string, unknown> = {}) => ({
  fullName: 'Ada Operator',
  email:    'ada@fleet.dev',
  memberships: [{
    organisationId: ORG_A, roleSlugs: [], allVehicles: true,
    vehicleIds: [], vehicleGroupIds: [],
  }],
  ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('an organisation admin is confined to their organisation', () => {
  it('refuses a membership for another tenant outright', async () => {
    arrange()
    await expect(
      provisioning.provisionUser(
        dto({ memberships: [{ organisationId: ORG_B, roleSlugs: [], allVehicles: true, vehicleIds: [], vehicleGroupIds: [] }] }),
        { restrictToOrgId: ORG_A },
      ),
    ).rejects.toThrow(/Validation/i)
  })

  /**
   * Refused, not filtered. Silently dropping the part of a request a caller may
   * not make is how someone ends up believing they granted access they did not.
   */
  it('refuses the WHOLE request when one membership is out of bounds', async () => {
    arrange()
    await expect(
      provisioning.provisionUser(
        dto({ memberships: [
          { organisationId: ORG_A, roleSlugs: [], allVehicles: true, vehicleIds: [], vehicleGroupIds: [] },
          { organisationId: ORG_B, roleSlugs: [], allVehicles: true, vehicleIds: [], vehicleGroupIds: [] },
        ] }),
        { restrictToOrgId: ORG_A },
      ),
    ).rejects.toThrow()
    expect(prismaMock.user.create).not.toHaveBeenCalled()
  })

  it('allows the same call unrestricted, which is the platform path', async () => {
    arrange()
    const out = await provisioning.provisionUser(
      dto({ memberships: [{ organisationId: ORG_B, roleSlugs: [], allVehicles: true, vehicleIds: [], vehicleGroupIds: [] }] }),
    )
    expect(out).toBeTruthy()
  })
})

describe('a scope must mean what it says', () => {
  it('refuses vehicle ids that belong to another organisation', async () => {
    arrange({ 'vehicle.count': 1 })   // asked for 2, only 1 is in this org
    await expect(provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: [], allVehicles: false,
                      vehicleIds: ['v1', 'v2'], vehicleGroupIds: [] }],
    }))).rejects.toThrow(/Validation/i)
  })

  it('refuses group ids that belong to another organisation', async () => {
    arrange({ 'vehicleGroup.count': 0 })
    await expect(provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: [], allVehicles: false,
                      vehicleIds: [], vehicleGroupIds: ['g1'] }],
    }))).rejects.toThrow(/Validation/i)
  })

  /**
   * Legal for the resolver — it correctly yields "sees nothing" — but almost
   * certainly a mistake as a REQUEST, and one that presents to the user as a
   * broken map rather than as a permissions problem.
   */
  it('refuses a restriction that names nothing', async () => {
    arrange()
    await expect(provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: [], allVehicles: false,
                      vehicleIds: [], vehicleGroupIds: [] }],
    }))).rejects.toThrow(/Validation/i)
  })

  it('accepts a scope whose ids all check out', async () => {
    arrange({ 'vehicle.count': 2 })
    await provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: [], allVehicles: false,
                      vehicleIds: ['v1', 'v2'], vehicleGroupIds: [] }],
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (prismaMock.membershipVehicleScope.createMany as any).mock.calls[0][0].data
    expect(rows.map((r: { vehicleId: string }) => r.vehicleId).sort()).toEqual(['v1', 'v2'])
  })

  /** Narrowing must be possible, so the set is replaced rather than merged. */
  it('replaces the previous scope instead of adding to it', async () => {
    arrange({ 'vehicle.count': 1 })
    await provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: [], allVehicles: false,
                      vehicleIds: ['v1'], vehicleGroupIds: [] }],
    }))
    expect(prismaMock.membershipVehicleScope.deleteMany).toHaveBeenCalledWith({ where: { membershipId: 'mem_1' } })
  })

  it('writes no scope rows at all when the whole fleet is granted', async () => {
    arrange()
    await provisioning.provisionUser(dto())
    expect(prismaMock.membershipVehicleScope.createMany).not.toHaveBeenCalled()
  })
})

describe('roles', () => {
  it('refuses a slug that does not exist in this organisation', async () => {
    arrange({ 'role.findMany': [] })
    await expect(provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: ['nonesuch'], allVehicles: true,
                      vehicleIds: [], vehicleGroupIds: [] }],
    }))).rejects.toThrow(/not found/i)
  })

  /**
   * A platform role applies in EVERY organisation, so granting one is not an
   * organisation-level act. `grantedById` is set only on the org-admin path.
   */
  it('refuses a platform role granted through an organisation', async () => {
    arrange({ 'role.findMany': [{ id: 'r_super', slug: 'super_admin', organisationId: null }] })
    await expect(provisioning.provisionUser(
      dto({ memberships: [{ organisationId: ORG_A, roleSlugs: ['super_admin'], allVehicles: true,
                            vehicleIds: [], vehicleGroupIds: [] }] }),
      { restrictToOrgId: ORG_A, grantedById: 'usr_admin' },
    )).rejects.toThrow(/Validation/i)
  })

  it('grants an org role by slug', async () => {
    arrange({ 'role.findMany': [{ id: 'r_op', slug: 'operator', organisationId: ORG_A }] })
    await provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: ['operator'], allVehicles: true,
                      vehicleIds: [], vehicleGroupIds: [] }],
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.userRole.create as any).mock.calls[0][0].data).toMatchObject({
      userId: 'usr_new', roleId: 'r_op',
    })
  })

  it('revokes a role in this organisation that the new set omits', async () => {
    arrange({
      'role.findMany':     [{ id: 'r_op', slug: 'operator', organisationId: ORG_A }],
      'userRole.findMany': [{ id: 'ur_old', roleId: 'r_stale' }],
    })
    await provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: ['operator'], allVehicles: true,
                      vehicleIds: [], vehicleGroupIds: [] }],
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (prismaMock.userRole.updateMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ id: { in: ['ur_old'] } })
    expect(call.data.revokedAt).toBeInstanceOf(Date)
  })

  it('only ever considers roles in this organisation when revoking', async () => {
    arrange({ 'role.findMany': [{ id: 'r_op', slug: 'operator', organisationId: ORG_A }] })
    await provisioning.provisionUser(dto({
      memberships: [{ organisationId: ORG_A, roleSlugs: ['operator'], allVehicles: true,
                      vehicleIds: [], vehicleGroupIds: [] }],
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.userRole.findMany as any).mock.calls[0][0].where)
      .toEqual({ userId: 'usr_new', revokedAt: null, role: { organisationId: ORG_A } })
  })
})

describe('an account that already exists', () => {
  it('gains the new organisation rather than being refused', async () => {
    arrange({ 'user.findFirst': { id: 'usr_existing', deletedAt: null } })
    await provisioning.provisionUser(dto())
    expect(prismaMock.user.create).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.orgMembership.upsert as any).mock.calls[0][0].where)
      .toEqual({ userId_organisationId: { userId: 'usr_existing', organisationId: ORG_A } })
  })

  it('is refused if it was removed, rather than silently resurrected', async () => {
    arrange({ 'user.findFirst': { id: 'usr_gone', deletedAt: new Date() } })
    await expect(provisioning.provisionUser(dto())).rejects.toThrow(/removed/i)
  })
})

describe('revoking a membership', () => {
  it('revokes the roles held there along with it', async () => {
    arrange()
    await provisioning.revokeMembership('usr_1', ORG_A, { restrictToOrgId: ORG_A })

    expect(prismaMock.orgMembership.update).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (prismaMock.userRole.updateMany as any).mock.calls[0][0]
    expect(call.where).toEqual({ userId: 'usr_1', revokedAt: null, role: { organisationId: ORG_A } })
  })

  it('cannot be aimed at another organisation', async () => {
    arrange()
    await expect(
      provisioning.revokeMembership('usr_1', ORG_B, { restrictToOrgId: ORG_A }),
    ).rejects.toThrow(/Validation/i)
  })

  it('is a soft revoke — nothing is deleted', async () => {
    arrange()
    await provisioning.revokeMembership('usr_1', ORG_A)
    expect(prismaMock.orgMembership.delete).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.orgMembership.update as any).mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date)
  })

  /* ── The home organisation follows ──────────────────────────────────────
     `users.organisation_id` was set once at creation and never revisited, so
     somebody granted four organisations and removed from three kept a home
     organisation naming one they had lost — and the account page printed it
     directly above an Organisations list that did not contain it. */

  /** The user row and the surviving membership the rehome reads. */
  function rehome(homeOrgId: string | null, survivorOrgId: string | null) {
    const m = prismaMock as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    m['user']!['findUnique']!.mockResolvedValue(
      homeOrgId === null ? null : { organisationId: homeOrgId },
    )
    m['orgMembership']!['findFirst']!.mockResolvedValue(
      survivorOrgId === null ? null : { organisationId: survivorOrgId },
    )
  }

  it('moves the home organisation to what is left when the home one is revoked', async () => {
    arrange()
    rehome(ORG_A, ORG_B)
    await provisioning.revokeMembership('usr_1', ORG_A)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (prismaMock.user.update as any).mock.calls.at(-1)[0]
    expect(call.where).toEqual({ id: 'usr_1' })
    expect(call.data).toEqual({ organisationId: ORG_B })
  })

  it('takes the OLDEST surviving membership, so a repair pass agrees with a live revoke', async () => {
    arrange()
    rehome(ORG_A, ORG_B)
    await provisioning.revokeMembership('usr_1', ORG_A)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = (prismaMock.orgMembership.findFirst as any).mock.calls.at(-1)[0]
    expect(query.where).toEqual({ userId: 'usr_1', revokedAt: null })
    expect(query.orderBy).toEqual({ createdAt: 'asc' })
  })

  it('leaves the home organisation alone when it is not the one being revoked', async () => {
    arrange()
    rehome(ORG_B, ORG_B)
    await provisioning.revokeMembership('usr_1', ORG_A)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })

  it('leaves it alone when nothing survives — the column is NOT NULL', async () => {
    arrange()
    // Their last organisation. A stale home is a better record than a crash:
    // they did work there, and this is the shape every registry driver has.
    rehome(ORG_A, null)
    await provisioning.revokeMembership('usr_1', ORG_A)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })
})
