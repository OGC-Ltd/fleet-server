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
  ALL_PERMISSIONS, FLAGGED_ONLY, PERMISSION_CATALOGUE, ROLE_DEFINITIONS, WILDCARD, splitSlug,
} from '../../lib/permissions.js'
import {
  applyPersonalGrants, invalidateSubject, permissionsIn,
  type OrgGrant, type PersonalGrant, type Subject,
} from '../../lib/authz/subject.js'
import type { GrantChange, ListUsersQuery } from './iam.schema.js'

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
        select: { organisation: { select: { id: true, name: true, code: true } } },
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

  return {
    user: { id: user.id, fullName: user.fullName, email: user.email, status: user.status },
    roles: distinctRoles(user.userRoles),
    systemAdministrator,
    everyOrganisation: isPlatform,
    organisations: organisations.map((o) => ({
      ...o,
      fromRoles: everything(permissionsIn(fromRoles, o.id)),
      effective: everything(permissionsIn(effective, o.id)),
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
