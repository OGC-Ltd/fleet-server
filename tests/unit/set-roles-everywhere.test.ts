import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Roles are organisation independent (operator, 2026-10-27): changing a
 * person's role from one organisation's roster replaces it in every
 * organisation they belong to, and their platform roles with it.
 *
 * Run against a small in-memory stand-in for the tables the path touches.
 */

type Role = { id: string; slug: string; organisationId: string | null }
type Grant = { id: string; userId: string; roleId: string; revokedAt: Date | null }
type Membership = { id: string; userId: string; organisationId: string; allVehicles: boolean; revokedAt: Date | null }
type Scope = { membershipId: string; vehicleId: string | null; vehicleGroupId: string | null }

const db = {
  roles: [] as Role[],
  grants: [] as Grant[],
  memberships: [] as Membership[],
  scopes: [] as Scope[],
  vehicles: [] as { id: string; organisationId: string }[],
}
let seq = 0
const roleOf = (id: string) => db.roles.find((r) => r.id === id)!
const orgFilter = (r: Role, f: unknown): boolean => {
  if (f === undefined) return true
  if (f === null) return r.organisationId === null
  if (typeof f === 'string') return r.organisationId === f
  const o = f as { in?: string[] }
  return o.in ? o.in.includes(r.organisationId ?? '') : true
}
const roleMatches = (r: Role, w: Record<string, unknown>): boolean => {
  const slug = w['slug'] as { in?: string[] } | undefined
  if (slug?.in && !slug.in.includes(r.slug)) return false
  if ('organisationId' in w && !orgFilter(r, w['organisationId'])) return false
  const or = w['OR'] as Record<string, unknown>[] | undefined
  if (or && !or.some((x) => roleMatches(r, x))) return false
  return true
}

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    user: { findFirst: async () => ({ id: 'u1' }) },
    organisation: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
    vehicle: {
      count: async ({ where }: { where: { id: { in: string[] }; organisationId: string } }) =>
        db.vehicles.filter((v) => where.id.in.includes(v.id) && v.organisationId === where.organisationId).length,
    },
    vehicleGroup: { count: async () => 0 },
    role: { findMany: async ({ where }: { where: Record<string, unknown> }) => db.roles.filter((r) => roleMatches(r, where)) },
    orgMembership: {
      findMany: async ({ where }: { where: { userId: string } }) => db.memberships
        .filter((m) => m.userId === where.userId && !m.revokedAt)
        .map((m) => ({
          ...m,
          organisation: { name: m.organisationId, code: m.organisationId },
          vehicleScopes: db.scopes.filter((s) => s.membershipId === m.id),
        })),
      upsert: async ({ where, create, update }: {
        where: { userId_organisationId: { userId: string; organisationId: string } }
        create: { userId: string; organisationId: string; allVehicles: boolean }
        update: { allVehicles: boolean }
      }) => {
        const k = where.userId_organisationId
        let m = db.memberships.find((x) => x.userId === k.userId && x.organisationId === k.organisationId)
        if (m) { m.allVehicles = update.allVehicles; m.revokedAt = null }
        else { m = { id: `m${++seq}`, ...create, revokedAt: null }; db.memberships.push(m) }
        return { id: m.id }
      },
    },
    membershipVehicleScope: {
      deleteMany: async ({ where }: { where: { membershipId: string } }) => {
        db.scopes = db.scopes.filter((s) => s.membershipId !== where.membershipId)
      },
      createMany: async ({ data }: { data: Partial<Scope>[] }) => {
        for (const d of data) db.scopes.push({ membershipId: d.membershipId!, vehicleId: d.vehicleId ?? null, vehicleGroupId: d.vehicleGroupId ?? null })
      },
    },
    userRole: {
      findMany: async ({ where }: { where: { userId: string; role?: { organisationId: string | null } } }) => db.grants
        .filter((g) => g.userId === where.userId && !g.revokedAt)
        .filter((g) => !where.role || roleOf(g.roleId).organisationId === where.role.organisationId)
        .map((g) => ({ ...g, role: roleOf(g.roleId) })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { revokedAt: Date } }) => {
        for (const g of db.grants) if (where.id.in.includes(g.id)) g.revokedAt = data.revokedAt
      },
      create: async ({ data }: { data: { userId: string; roleId: string } }) => {
        db.grants.push({ id: `g${++seq}`, userId: data.userId, roleId: data.roleId, revokedAt: null })
      },
    },
  },
}))
const invalidateSubject = vi.fn()
vi.mock('../../src/lib/authz/subject.js', () => ({ invalidateSubject: (id: string) => invalidateSubject(id) }))
vi.mock('../../src/modules/users/roster.cache.js', () => ({ invalidateRosterForUser: async () => {} }))

import { setRolesEverywhere } from '../../src/modules/users/provisioning.service.js'

const live = () => db.grants.filter((g) => !g.revokedAt).map((g) => {
  const r = roleOf(g.roleId)
  return `${r.slug}@${r.organisationId ?? 'PLATFORM'}`
}).sort()

function grant(slug: string, org: string | null) {
  const r = db.roles.find((x) => x.slug === slug && x.organisationId === org)!
  db.grants.push({ id: `g${++seq}`, userId: 'u1', roleId: r.id, revokedAt: null })
}
function member(org: string, allVehicles = true, vehicleIds: string[] = []) {
  const m = { id: `m${++seq}`, userId: 'u1', organisationId: org, allVehicles, revokedAt: null }
  db.memberships.push(m)
  for (const v of vehicleIds) db.scopes.push({ membershipId: m.id, vehicleId: v, vehicleGroupId: null })
}

beforeEach(() => {
  seq = 0
  invalidateSubject.mockReset()
  db.roles = [
    { id: 'p-super', slug: 'super_admin', organisationId: null },
    { id: 'p-dir', slug: 'director', organisationId: null },
    ...['KASULU', 'SUKARI'].flatMap((o) => ['operator', 'supervisor', 'manager'].map((slug) => ({ id: `${o}-${slug}`, slug, organisationId: o }))),
    { id: 'KASULU-custom', slug: 'yard_lead', organisationId: 'KASULU' },
  ]
  db.grants = []
  db.memberships = []
  db.scopes = []
  db.vehicles = [{ id: 'v1', organisationId: 'KASULU' }]
})

describe('setRolesEverywhere', () => {
  it('takes the platform role away from a platform administrator made operator', async () => {
    member('KASULU')
    grant('supervisor', 'KASULU')
    grant('super_admin', null)

    await setRolesEverywhere('u1', ['operator'], { fromOrgId: 'KASULU' })

    expect(live()).toEqual(['operator@KASULU'])
    expect(invalidateSubject).toHaveBeenCalledWith('u1')
  })

  it('sets the same role in every organisation they belong to', async () => {
    member('KASULU')
    member('SUKARI')
    grant('manager', 'KASULU')
    grant('supervisor', 'SUKARI')

    await setRolesEverywhere('u1', ['operator'], { fromOrgId: 'KASULU' })

    expect(live()).toEqual(['operator@KASULU', 'operator@SUKARI'])
  })

  it('adds the organisation it was changed from when they were not yet a member', async () => {
    member('SUKARI')
    grant('manager', 'SUKARI')

    await setRolesEverywhere('u1', ['supervisor'], { fromOrgId: 'KASULU' })

    expect(live()).toEqual(['supervisor@KASULU', 'supervisor@SUKARI'])
  })

  it('keeps a vehicle restriction the new role allows, and widens one it does not', async () => {
    member('KASULU', false, ['v1'])
    grant('operator', 'KASULU')

    await setRolesEverywhere('u1', ['operator'], { fromOrgId: 'KASULU' })
    expect(db.memberships[0]!.allVehicles).toBe(false)
    expect(db.scopes.map((s) => s.vehicleId)).toEqual(['v1'])

    await setRolesEverywhere('u1', ['supervisor'], { fromOrgId: 'KASULU' })
    expect(db.memberships[0]!.allVehicles).toBe(true)
    expect(db.scopes).toEqual([])
  })

  it('refuses a platform role unless the caller may grant one', async () => {
    member('KASULU')
    grant('operator', 'KASULU')

    await expect(setRolesEverywhere('u1', ['director'], { fromOrgId: 'KASULU' })).rejects.toThrow()
    expect(live()).toEqual(['operator@KASULU'])

    await setRolesEverywhere('u1', ['director'], { fromOrgId: 'KASULU', allowPlatformRoles: true })
    expect(live()).toEqual(['director@PLATFORM'])
  })

  it('changes nothing when a role is missing in one of their organisations', async () => {
    member('KASULU')
    member('SUKARI')
    grant('operator', 'KASULU')
    grant('operator', 'SUKARI')

    await expect(setRolesEverywhere('u1', ['yard_lead'], { fromOrgId: 'KASULU' })).rejects.toThrow(/yard_lead in SUKARI/)
    expect(live()).toEqual(['operator@KASULU', 'operator@SUKARI'])
  })
})
