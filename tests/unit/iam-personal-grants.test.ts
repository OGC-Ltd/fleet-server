/**
 * Rights given to, or taken from, one person (IAM), laid over their role.
 *
 * The rules a grant must keep are the ones that would be a breach if they
 * slipped: it never opens an organisation, it never hands out the wildcard,
 * a denial always beats an allowance, and the holder of the wildcard is left
 * exactly as they were.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
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
  applyPersonalGrants, can, canReachOrg, permissionsIn, resolveSubject,
  type OrgGrant, type PersonalGrant,
} from '../../src/lib/authz/subject.js'
import { isGrantable, catalogue, setGrants, setFleetAccess } from '../../src/modules/iam/iam.service.js'
import { FLAGGED_ONLY, WILDCARD } from '../../src/lib/permissions.js'

const ORG_A = 'org_a'
const ORG_B = 'org_b'

const personal = (organisationId: string | null, slug: string, effect: 'allow' | 'deny'): PersonalGrant =>
  ({ organisationId, effect, permission: { slug } })

const org = (...slugs: string[]): OrgGrant => ({ permissions: new Set(slugs), vehicleIds: null })

const member = (orgs: Record<string, string[]>) => ({
  isPlatform: false,
  platformPermissions: new Set<string>(),
  orgs: new Map(Object.entries(orgs).map(([id, slugs]) => [id, org(...slugs)])),
})

describe('applyPersonalGrants: an organisation member', () => {
  it('adds a right in the one organisation named', () => {
    const into = member({ [ORG_A]: ['map:read'], [ORG_B]: ['map:read'] })
    applyPersonalGrants([personal(ORG_A, 'report:read', 'allow')], into)
    expect(into.orgs.get(ORG_A)?.permissions.has('report:read')).toBe(true)
    expect(into.orgs.get(ORG_B)?.permissions.has('report:read')).toBe(false)
  })

  it('adds a right everywhere they reach when no organisation is named', () => {
    const into = member({ [ORG_A]: [], [ORG_B]: [] })
    applyPersonalGrants([personal(null, 'report:read', 'allow')], into)
    expect(into.orgs.get(ORG_A)?.permissions.has('report:read')).toBe(true)
    expect(into.orgs.get(ORG_B)?.permissions.has('report:read')).toBe(true)
    // Not a platform right: it must not make them one.
    expect(into.platformPermissions.size).toBe(0)
  })

  it('never opens an organisation they are not a member of', () => {
    const into = member({ [ORG_A]: ['map:read'] })
    applyPersonalGrants([personal(ORG_B, 'map:read', 'allow')], into)
    expect(into.orgs.has(ORG_B)).toBe(false)
  })

  it('takes away a right the role gave', () => {
    const into = member({ [ORG_A]: ['map:read', 'report:read'] })
    applyPersonalGrants([personal(ORG_A, 'report:read', 'deny')], into)
    expect([...into.orgs.get(ORG_A)!.permissions]).toEqual(['map:read'])
  })

  it('lets a denial beat an allowance, whichever comes first', () => {
    for (const grants of [
      [personal(null, 'report:read', 'allow'), personal(ORG_A, 'report:read', 'deny')],
      [personal(ORG_A, 'report:read', 'deny'), personal(null, 'report:read', 'allow')],
    ]) {
      const into = member({ [ORG_A]: [], [ORG_B]: [] })
      applyPersonalGrants(grants, into)
      expect(into.orgs.get(ORG_A)?.permissions.has('report:read')).toBe(false)
      expect(into.orgs.get(ORG_B)?.permissions.has('report:read')).toBe(true)
    }
  })

  it('ignores the wildcard and the flagged-only restriction', () => {
    const into = member({ [ORG_A]: ['map:read'] })
    applyPersonalGrants([personal(ORG_A, WILDCARD, 'allow'), personal(null, FLAGGED_ONLY, 'allow')], into)
    expect([...into.orgs.get(ORG_A)!.permissions]).toEqual(['map:read'])
  })
})

describe('applyPersonalGrants: a platform role', () => {
  const director = () => ({
    isPlatform: true,
    platformPermissions: new Set(['map:read', 'report:read']),
    orgs: new Map<string, OrgGrant>(),
  })

  it('records a denial in one organisation for question time', () => {
    const into = director()
    const denied = applyPersonalGrants([personal(ORG_A, 'report:read', 'deny')], into)
    expect(denied.get(ORG_A)?.has('report:read')).toBe(true)
    // Still held on the platform, so every other organisation keeps it.
    expect(into.platformPermissions.has('report:read')).toBe(true)
  })

  it('leaves the holder of the wildcard exactly as they were', () => {
    const into = { isPlatform: true, platformPermissions: new Set([WILDCARD]), orgs: new Map<string, OrgGrant>() }
    const denied = applyPersonalGrants([personal(null, 'report:read', 'deny'), personal(ORG_A, 'map:read', 'deny')], into)
    expect(denied.size).toBe(0)
    expect([...into.platformPermissions]).toEqual([WILDCARD])
  })
})

describe('resolveSubject with personal grants', () => {
  const setup = (memberships: unknown[], roles: unknown[], grants: unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prismaMock as any
    p.orgMembership.findMany.mockResolvedValue(memberships)
    p.userRole.findMany.mockResolvedValue(roles)
    p.vehicle.findMany.mockResolvedValue([])
    p.userPermissionGrant.findMany.mockResolvedValue(grants)
  }
  const role = (organisationId: string | null, ...slugs: string[]) => ({
    role: { organisationId, permissions: slugs.map((slug) => ({ permission: { slug } })) },
  })
  const membership = (organisationId: string) => ({ organisationId, allVehicles: true, vehicleScopes: [] })

  beforeEach(() => { vi.clearAllMocks() })

  it('a member gains the granted right and loses the denied one', async () => {
    setup([membership(ORG_A)], [role(ORG_A, 'map:read', 'report:read')], [
      personal(ORG_A, 'fuel_audit:read', 'allow'),
      personal(ORG_A, 'report:read', 'deny'),
    ])
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'fuel_audit:read')).toBe(true)
    expect(can(s, ORG_A, 'report:read')).toBe(false)
    expect(can(s, ORG_A, 'map:read')).toBe(true)
    expect(s.isPlatform).toBe(false)
  })

  it('a grant in another organisation gives no way in', async () => {
    setup([membership(ORG_A)], [role(ORG_A, 'map:read')], [personal(ORG_B, 'map:read', 'allow')])
    const s = await resolveSubject('u1')
    expect(canReachOrg(s, ORG_B)).toBe(false)
    expect(can(s, ORG_B, 'map:read')).toBe(false)
  })

  it('a director denied a right in one organisation keeps it in the others', async () => {
    setup([], [role(null, 'map:read', 'report:read')], [personal(ORG_A, 'report:read', 'deny')])
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'report:read')).toBe(false)
    expect(can(s, ORG_B, 'report:read')).toBe(true)
    expect(permissionsIn(s, ORG_A).has('map:read')).toBe(true)
  })

  it('the System Administrator cannot be narrowed', async () => {
    setup([], [role(null, WILDCARD)], [personal(null, 'report:read', 'deny')])
    const s = await resolveSubject('u1')
    expect(can(s, ORG_A, 'report:read')).toBe(true)
  })
})

describe('what may be given to one person', () => {
  it('refuses the wildcard, every platform right and the flagged-only restriction', () => {
    expect(isGrantable(WILDCARD)).toBe(false)
    expect(isGrantable('platform:read_all')).toBe(false)
    expect(isGrantable(FLAGGED_ONLY)).toBe(false)
    expect(isGrantable('not:a_permission')).toBe(false)
    expect(isGrantable('report:read')).toBe(true)
  })

  it('lists every permission once, grouped by resource', () => {
    const { resources, roles } = catalogue()
    const slugs = resources.flatMap((r) => r.permissions.map((p) => (p as { slug: string }).slug))
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs).toContain('report:read')
    expect(roles.find((r) => r.slug === 'super_admin')?.name).toBe('System Administrator')
    expect(roles.find((r) => r.slug === 'admin')?.name).toBe('Admin')
  })
})

describe('setGrants refusals', () => {
  const user = (roles: unknown[], memberships: unknown[] = []) => ({
    id: 'u1', fullName: 'A Person', email: 'a@example.test', status: 'active',
    userRoles: roles, memberships, permissionGrants: [],
  })
  const dbRole = (slug: string, organisationId: string | null, ...slugs: string[]) => ({
    role: { slug, name: slug, organisationId, permissions: slugs.map((s) => ({ permission: { slug: s } })) },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prismaMock as any
  beforeEach(() => {
    p.vehicleGroup.findMany.mockResolvedValue([])
    p.vehicle.groupBy.mockResolvedValue([])
  })

  it('refuses to change the System Administrator', async () => {
    p.user.findFirst.mockResolvedValue(user([dbRole('super_admin', null, WILDCARD)]))
    p.organisation.findMany.mockResolvedValue([{ id: ORG_A, name: 'A', code: 'A' }])
    await expect(setGrants('actor', 'u1', [{ organisationId: null, permission: 'report:read', effect: 'deny' }]))
      .rejects.toThrow(/already holds every access right/)
    expect(p.$transaction).not.toHaveBeenCalled()
  })

  it('refuses a right that is not personal', async () => {
    p.user.findFirst.mockResolvedValue(user(
      [dbRole('manager', ORG_A, 'map:read')],
      [{ organisation: { id: ORG_A, name: 'A', code: 'A' }, allVehicles: true, vehicleScopes: [] }],
    ))
    await expect(setGrants('actor', 'u1', [{ organisationId: ORG_A, permission: WILDCARD, effect: 'allow' }]))
      .rejects.toThrow(/cannot be given to one person/)
  })

  it('refuses an organisation the person is not in', async () => {
    p.user.findFirst.mockResolvedValue(user(
      [dbRole('manager', ORG_A, 'map:read')],
      [{ organisation: { id: ORG_A, name: 'A', code: 'A' }, allVehicles: true, vehicleScopes: [] }],
    ))
    await expect(setGrants('actor', 'u1', [{ organisationId: ORG_B, permission: 'report:read', effect: 'allow' }]))
      .rejects.toThrow(/not a member of that organisation/)
    expect(p.$transaction).not.toHaveBeenCalled()
  })
})

describe('setFleetAccess: limiting a person to fleet categories', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prismaMock as any
  const TANKERS = 'grp_tankers'
  const VAN_SALES = 'grp_van_sales'
  const person = (slug: string, allVehicles = true, groupIds: string[] = []) => ({
    id: 'u1', fullName: 'A Person', email: 'a@example.test', status: 'active',
    userRoles: [{ role: { slug, name: slug, organisationId: ORG_A, permissions: [] } }],
    memberships: [{
      organisation: { id: ORG_A, name: 'Menengai', code: 'MENENGAI' },
      allVehicles,
      vehicleScopes: groupIds.map((vehicleGroupId) => ({ vehicleId: null, vehicleGroupId })),
    }],
    permissionGrants: [],
  })
  beforeEach(() => {
    p.vehicleGroup.findMany.mockResolvedValue([
      { id: VAN_SALES, name: 'Van Sales', organisationId: ORG_A },
      { id: TANKERS, name: 'Tankers', organisationId: ORG_A },
      { id: 'grp_old', name: 'Menengai · VS', organisationId: ORG_A },
    ])
    p.vehicle.groupBy.mockResolvedValue([
      { vehicleGroupId: TANKERS, _count: { _all: 53 } },
      { vehicleGroupId: VAN_SALES, _count: { _all: 71 } },
    ])
  })

  it('lists categories in the client order and leaves out empty ones', async () => {
    p.user.findFirst.mockResolvedValue(person('operator'))
    p.vehicleGroup.count.mockResolvedValue(1)
    p.orgMembership.findFirst.mockResolvedValue({ id: 'm1' })
    p.$transaction.mockResolvedValue(undefined)
    const out = await setFleetAccess('actor', 'u1', { organisationId: ORG_A, allVehicles: false, vehicleGroupIds: [TANKERS] })
    const fleet = out.organisations[0]!.fleet
    expect(fleet.narrowable).toBe(true)
    expect(fleet.categories.map((c) => c.name)).toEqual(['Tankers', 'Van Sales'])
    expect(p.$transaction).toHaveBeenCalled()
  })

  it("narrows any organisation role: a person's own setting overrides the role (2026-11-14)", async () => {
    for (const slug of ['supervisor', 'fleet_analyst', 'technician', 'admin', 'head_of_security']) {
      p.user.findFirst.mockResolvedValue(person(slug))
      p.vehicleGroup.count.mockResolvedValue(1)
      p.orgMembership.findFirst.mockResolvedValue({ id: 'm1' })
      p.$transaction.mockResolvedValue(undefined)
      const out = await setFleetAccess('actor', 'u1', { organisationId: ORG_A, allVehicles: false, vehicleGroupIds: [TANKERS] })
      expect(out.organisations[0]!.fleet).toMatchObject({ narrowable: true, reason: null })
    }
    expect(p.$transaction).toHaveBeenCalledTimes(5)
  })

  it('refuses an empty choice of categories', async () => {
    p.user.findFirst.mockResolvedValue(person('operator'))
    await expect(setFleetAccess('actor', 'u1', { organisationId: ORG_A, allVehicles: false, vehicleGroupIds: [] }))
      .rejects.toThrow(/at least one category/)
  })

  it("refuses another organisation's category", async () => {
    p.user.findFirst.mockResolvedValue(person('operator'))
    p.vehicleGroup.count.mockResolvedValue(0)
    await expect(setFleetAccess('actor', 'u1', { organisationId: ORG_A, allVehicles: false, vehicleGroupIds: ['grp_elsewhere'] }))
      .rejects.toThrow(/not this organisation/)
    expect(p.$transaction).not.toHaveBeenCalled()
  })

  it('gives the whole fleet back to any role', async () => {
    p.user.findFirst.mockResolvedValue(person('supervisor', false, [TANKERS]))
    p.orgMembership.findFirst.mockResolvedValue({ id: 'm1' })
    p.$transaction.mockResolvedValue(undefined)
    await setFleetAccess('actor', 'u1', { organisationId: ORG_A, allVehicles: true, vehicleGroupIds: [] })
    expect(p.$transaction).toHaveBeenCalled()
  })
})
