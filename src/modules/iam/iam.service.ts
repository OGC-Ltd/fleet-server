/**
 * IAM: who holds what, and the rights given to or taken from one person.
 *
 * A person's access is their ROLE (one role everywhere, users/provisioning)
 * with their own grants laid over it. A grant is one permission, in one
 * organisation or in all of them, allowed or denied. The merge itself lives
 * in lib/authz/subject (applyPersonalGrants) and this module calls that same
 * function to show the outcome, so the page can never describe an access the
 * request path would not give.
 *
 * Everything here is the System Administrator's alone (iam.routes).
 *
 * What a grant CANNOT do, by design:
 *   - open an organisation the person does not already reach;
 *   - hand out the wildcard (`platform:admin`): that is the System
 *     Administrator role and is given on the Users page;
 *   - set `vehicle:flagged_only`, which is a restriction a role carries;
 *   - change the holder of the wildcard, who already has everything.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { BadRequestError, NotFoundError } from '../../core/errors/errors.js'
import {
  ALL_PERMISSIONS, FLAGGED_ONLY, PERMISSION_CATALOGUE, ROLE_DEFINITIONS, VEHICLE_SCOPABLE_ROLE_SLUGS, WILDCARD, splitSlug,
} from '../../lib/permissions.js'
import { MENENGAI_FLEET_LIST } from '../../providers/wialon/menengai-fleet-list.js'
import {
  applyPersonalGrants, invalidateSubject, permissionsIn,
  type OrgGrant, type PersonalGrant, type Subject,
} from '../../lib/authz/subject.js'
import type { GrantChange, ListUsersQuery, SetFleetDto } from './iam.schema.js'

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** What each resource is called on the page. A resource not named here shows its own slug. */
const RESOURCE_LABELS: Record<string, string> = {
  vehicle:       'Vehicles',
  sensor:        'Sensors and probes',
  telemetry:     'Telemetry',
  map:           'Live map',
  dashboard:     'Dashboard',
  notification:  'Live feed',
  trip:          'Trips',
  cargo:         'Cargo',
  assignment:    'Driver assignments',
  dispatch:      'Dispatches',
  route:         'Routes',
  geofence:      'Geofences',
  analytics:     'Analytics',
  report:        'Reports',
  driver:        'Drivers',
  weighbridge:   'Weighbridge',
  fuel_filling:  'Fuel fillings',
  fuel_theft:    'Fuel theft cases',
  alerts:        'Alerts',
  fuel_audit:    'Fuel audit',
  fuel_review:   'Fuel review',
  logbook:       'Logbook',
  repair:        'Repairs',
  security_case: 'Security cases',
  ingest_key:    'Ingest keys',
  user:          'Users',
  role:          'Roles',
  organisation:  'Organisations',
  platform:      'Platform',
}

/** May this permission be given to, or taken from, one person? */
export function isGrantable(slug: string): boolean {
  return slug in PERMISSION_CATALOGUE
    && slug !== WILDCARD
    && slug !== FLAGGED_ONLY
    && splitSlug(slug).resource !== 'platform'
}

export function catalogue() {
  const resources = new Map<string, { resource: string; label: string; permissions: unknown[] }>()
  for (const slug of ALL_PERMISSIONS) {
    const { resource, action } = splitSlug(slug)
    const group = resources.get(resource)
      ?? { resource, label: RESOURCE_LABELS[resource] ?? resource, permissions: [] }
    group.permissions.push({ slug, action, name: PERMISSION_CATALOGUE[slug], grantable: isGrantable(slug) })
    resources.set(resource, group)
  }
  return {
    resources: [...resources.values()],
    roles: ROLE_DEFINITIONS.map((r) => ({
      slug: r.slug, name: r.name, description: r.description,
      platform: r.platform, permissions: r.permissions,
    })),
  }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Distinct roles by slug: one role held in six organisations is one role. */
function distinctRoles(rows: { role: { slug: string; name: string; organisationId: string | null } }[]) {
  const seen = new Map<string, { slug: string; name: string; platform: boolean }>()
  for (const { role } of rows) {
    if (!seen.has(role.slug)) seen.set(role.slug, { slug: role.slug, name: role.name, platform: role.organisationId === null })
  }
  return [...seen.values()]
}

/** Everybody who can sign in, with their role and how many personal grants they carry. */
export async function listUsers(query: ListUsersQuery) {
  const search = query.search?.trim()
  const where = {
    deletedAt: null,
    // Drivers synced from the registry have no email and never sign in.
    email: { not: null },
    ...(search ? {
      OR: [
        { fullName: { contains: search, mode: 'insensitive' as const } },
        { email:    { contains: search, mode: 'insensitive' as const } },
      ],
    } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { fullName: 'asc' },
      skip:    (query.page - 1) * query.limit,
      take:    query.limit,
      select: {
        id: true, fullName: true, email: true, status: true,
        userRoles: {
          where:  { revokedAt: null },
          select: { role: { select: { slug: true, name: true, organisationId: true } } },
        },
        memberships: {
          where:  { revokedAt: null },
          select: { organisation: { select: { id: true, name: true, code: true } } },
        },
        _count: { select: { permissionGrants: true } },
      },
    }),
    prisma.user.count({ where }),
  ])

  const data = rows.map((u) => {
    const roles = distinctRoles(u.userRoles)
    return {
      id: u.id, fullName: u.fullName, email: u.email, status: u.status,
      roles,
      systemAdministrator: roles.some((r) => r.slug === 'super_admin'),
      everyOrganisation:   roles.some((r) => r.platform),
      organisations: u.memberships.map((m) => m.organisation),
      grants: u._count.permissionGrants,
    }
  })
  return { data, total }
}

/**
 * One person's access, organisation by organisation: what the role gives, what
 * has been given or taken on top, and what that comes to.
 */
export async function userAccess(userId: string) {
  const user = await prisma.user.findFirst({
    where:  { id: userId, deletedAt: null },
    select: {
      id: true, fullName: true, email: true, status: true,
      userRoles: {
        where:  { revokedAt: null },
        select: {
          role: {
            select: {
              slug: true, name: true, organisationId: true,
              permissions: { select: { permission: { select: { slug: true } } } },
            },
          },
        },
      },
      memberships: {
        where:  { revokedAt: null },
        select: {
          organisation:  { select: { id: true, name: true, code: true } },
          allVehicles:   true,
          vehicleScopes: { select: { vehicleId: true, vehicleGroupId: true } },
        },
      },
      permissionGrants: {
        orderBy: { createdAt: 'asc' },
        select: {
          organisationId: true, effect: true, createdAt: true,
          permission: { select: { slug: true } },
          grantedBy:  { select: { fullName: true } },
        },
      },
    },
  })
  if (!user) throw new NotFoundError('User')

  const platformPermissions = new Set<string>()
  const byOrg = new Map<string, Set<string>>()
  for (const { role } of user.userRoles) {
    const target = role.organisationId === null
      ? platformPermissions
      : (byOrg.get(role.organisationId) ?? new Set<string>())
    for (const rp of role.permissions) target.add(rp.permission.slug)
    if (role.organisationId !== null) byOrg.set(role.organisationId, target)
  }
  const isPlatform = platformPermissions.size > 0
  const systemAdministrator = platformPermissions.has(WILDCARD)

  // A platform role reaches every organisation; anybody else, their memberships.
  const organisations = isPlatform
    ? await prisma.organisation.findMany({ select: { id: true, name: true, code: true }, orderBy: { createdAt: 'asc' } })
    : user.memberships.map((m) => m.organisation)

  const build = (): Subject => ({
    userId,
    isPlatform,
    platformPermissions: new Set(platformPermissions),
    orgs: new Map<string, OrgGrant>(organisations.map((o) => [
      o.id, { permissions: new Set(byOrg.get(o.id) ?? []), vehicleIds: null },
    ])),
  })

  const fromRoles = build()
  const effective = build()
  const personal: PersonalGrant[] = user.permissionGrants
  effective.denied = applyPersonalGrants(personal, effective)

  const everything = (set: Set<string>) => (set.has(WILDCARD) ? [...ALL_PERMISSIONS] : [...set])

  const fleets = await fleetAccess(user, isPlatform, organisations.map((o) => o.id))

  return {
    user: { id: user.id, fullName: user.fullName, email: user.email, status: user.status },
    roles: distinctRoles(user.userRoles),
    systemAdministrator,
    everyOrganisation: isPlatform,
    organisations: organisations.map((o) => ({
      ...o,
      fromRoles: everything(permissionsIn(fromRoles, o.id)),
      effective: everything(permissionsIn(effective, o.id)),
      fleet:     fleets.get(o.id)!,
    })),
    grants: user.permissionGrants.map((g) => ({
      organisationId: g.organisationId,
      permission:     g.permission.slug,
      effect:         g.effect,
      grantedBy:      g.grantedBy?.fullName ?? null,
      createdAt:      g.createdAt,
    })),
  }
}

/**
 * Give, take or hand back ("inherit") rights for one person.
 *
 * All of it or none of it: every change is checked before anything is
 * written, and the writes are one transaction.
 */
export async function setGrants(actorId: string, userId: string, changes: GrantChange[]) {
  const access = await userAccess(userId)
  if (access.systemAdministrator) {
    throw new BadRequestError('A System Administrator already holds every access right. Change their role on the Users page instead.')
  }

  const reachable = new Set(access.organisations.map((o) => o.id))
  for (const c of changes) {
    if (!isGrantable(c.permission)) {
      throw new BadRequestError(`"${c.permission}" cannot be given to one person`)
    }
    if (c.organisationId !== null && !reachable.has(c.organisationId)) {
      throw new BadRequestError('This person is not a member of that organisation. Add them to it on the Users page first.')
    }
  }

  const slugs = [...new Set(changes.map((c) => c.permission))]
  const rows = await prisma.permission.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } })
  const idOf = new Map(rows.map((r) => [r.slug, r.id]))
  const missing = slugs.filter((s) => !idOf.has(s))
  if (missing.length) {
    // In the catalogue but not yet in the table: the seed has not run since it was added.
    throw new BadRequestError(`Not in the permissions table yet: ${missing.join(', ')}. Run seed:rbac.`)
  }

  await prisma.$transaction(changes.flatMap((c) => {
    const permissionId = idOf.get(c.permission) as string
    const clear = prisma.userPermissionGrant.deleteMany({
      where: { userId, organisationId: c.organisationId, permissionId },
    })
    if (c.effect === 'inherit') return [clear]
    return [clear, prisma.userPermissionGrant.create({
      data: { userId, organisationId: c.organisationId, permissionId, effect: c.effect, grantedById: actorId },
    })]
  }))

  // The record of who changed what: the rows keep only what stands now.
  logger.info({ actorId, userId, changes }, 'iam: personal access rights changed')

  await invalidateSubject(userId)
  return userAccess(userId)
}

// ---------------------------------------------------------------------------
// Fleet access: the whole fleet, or only some of its categories
// ---------------------------------------------------------------------------

/** Menengai's categories in the client's order, then anything else by name. */
const LIST_ORDER = new Map(MENENGAI_FLEET_LIST.map((g, i) => [g.name, i]))

type FleetCategory = { id: string; name: string; units: number }

export type FleetAccess = {
  /**
   * May this person's fleet be narrowed here? Only under a role that is
   * vehicleScopable (lib/permissions), and never under a platform role, which
   * reaches every organisation whole.
   */
  narrowable: boolean
  /** Why not, in words for the page. */
  reason: string | null
  allVehicles: boolean
  /** The categories (vehicle groups) this person sees, when not the whole fleet. */
  groupIds: string[]
  /** Single units named on their own (through the Users API, not here). */
  singleUnits: number
  /** The organisation's categories and how many active units each holds. */
  categories: FleetCategory[]
}

type AccessUser = {
  userRoles: { role: { slug: string; organisationId: string | null } }[]
  memberships: {
    organisation: { id: string }
    allVehicles: boolean
    vehicleScopes: { vehicleId: string | null; vehicleGroupId: string | null }[]
  }[]
}

async function fleetAccess(user: AccessUser, isPlatform: boolean, orgIds: string[]): Promise<Map<string, FleetAccess>> {
  const [groups, counts] = await Promise.all([
    prisma.vehicleGroup.findMany({
      where:  { organisationId: { in: orgIds } },
      select: { id: true, name: true, organisationId: true },
    }),
    prisma.vehicle.groupBy({
      by:     ['vehicleGroupId'],
      where:  { organisationId: { in: orgIds }, isActive: true },
      _count: { _all: true },
    }),
  ])
  const unitsIn = new Map(counts.map((c) => [c.vehicleGroupId, c._count._all]))

  const out = new Map<string, FleetAccess>()
  for (const orgId of orgIds) {
    const m = user.memberships.find((x) => x.organisation.id === orgId)
    const groupIds = m && !m.allVehicles
      ? m.vehicleScopes.flatMap((s) => (s.vehicleGroupId ? [s.vehicleGroupId] : []))
      : []
    const roleSlugs = user.userRoles.filter((r) => r.role.organisationId === orgId).map((r) => r.role.slug)

    let reason: string | null = null
    if (isPlatform) reason = 'Their role covers every organisation, so they always see the whole fleet.'
    else if (!m) reason = 'Not a member of this organisation.'
    else if (roleSlugs.length === 0) reason = 'No role here yet.'
    else if (!roleSlugs.every((s) => VEHICLE_SCOPABLE_ROLE_SLUGS.includes(s))) {
      reason = 'This role always sees the whole fleet. Only Operator, Dispatch Manager and Logistics Manager can be limited to categories.'
    }

    // A category with no units is left off, unless this person holds it.
    const categories = groups
      .filter((g) => g.organisationId === orgId && ((unitsIn.get(g.id) ?? 0) > 0 || groupIds.includes(g.id)))
      .map((g) => ({ id: g.id, name: g.name, units: unitsIn.get(g.id) ?? 0 }))
      .sort((a, b) => (LIST_ORDER.get(a.name) ?? 999) - (LIST_ORDER.get(b.name) ?? 999) || a.name.localeCompare(b.name))

    out.set(orgId, {
      narrowable:  reason === null,
      reason,
      allVehicles: m ? m.allVehicles : true,
      groupIds,
      singleUnits: m && !m.allVehicles ? m.vehicleScopes.filter((s) => s.vehicleId).length : 0,
      categories,
    })
  }
  return out
}

/**
 * Set which part of one organisation's fleet a person sees: all of it, or the
 * named categories (operator, 2026-11-12: "assign an individual access to
 * tankers or van sales or finished goods"). The category is what is stored, so
 * a unit added to it later is seen too.
 *
 * Single units named through the Users API stay while narrowing, and go with
 * everything else when the whole fleet is given back.
 */
export async function setFleetAccess(actorId: string, userId: string, dto: SetFleetDto) {
  const access = await userAccess(userId)
  const org = access.organisations.find((o) => o.id === dto.organisationId)
  if (!org) throw new BadRequestError('This person is not a member of that organisation. Add them to it on the Users page first.')

  const groupIds = [...new Set(dto.vehicleGroupIds)]
  if (!dto.allVehicles) {
    if (!org.fleet.narrowable) throw new BadRequestError(org.fleet.reason ?? 'This person always sees the whole fleet here.')
    if (groupIds.length === 0) throw new BadRequestError('Pick at least one category, or give the whole fleet.')
    const found = await prisma.vehicleGroup.count({ where: { id: { in: groupIds }, organisationId: org.id } })
    if (found !== groupIds.length) throw new BadRequestError("One or more categories are not this organisation's.")
  }

  const membership = await prisma.orgMembership.findFirst({
    where:  { userId, organisationId: org.id, revokedAt: null },
    select: { id: true },
  })
  if (!membership) throw new NotFoundError('Membership')

  await prisma.$transaction(async (tx) => {
    await tx.orgMembership.update({ where: { id: membership.id }, data: { allVehicles: dto.allVehicles } })
    if (dto.allVehicles) {
      await tx.membershipVehicleScope.deleteMany({ where: { membershipId: membership.id } })
      return
    }
    await tx.membershipVehicleScope.deleteMany({ where: { membershipId: membership.id, vehicleGroupId: { not: null } } })
    await tx.membershipVehicleScope.createMany({
      data: groupIds.map((vehicleGroupId) => ({ membershipId: membership.id, vehicleGroupId })),
      skipDuplicates: true,
    })
  })

  logger.info({ actorId, userId, organisationId: org.id, allVehicles: dto.allVehicles, vehicleGroupIds: groupIds },
    'iam: fleet access changed')

  await invalidateSubject(userId)
  return userAccess(userId)
}
