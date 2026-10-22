/**
 * Creating people, and deciding what they may reach.
 *
 * Two callers, one body of rules:
 *
 *   POST /api/v1/users                      super admin. May name any number of
 *                                           organisations, with a different role
 *                                           in each.
 *   POST /organisations/:orgId/users        organisation admin. Identical, except
 *                                           the organisation is the one in the
 *                                           path and cannot be anything else.
 *
 * That second constraint is enforced by the CALLER passing `restrictToOrgId`,
 * not by trusting the request body. An admin at SUKARI who posts a membership
 * for KASULU is refused rather than quietly filtered, because silently dropping
 * part of a request is how someone ends up believing they granted access they
 * did not.
 *
 * A role is named by SLUG, not id. Roles are per organisation, so `operator` is
 * a different row in each one, and making the client look up four ids to grant
 * the same role in four places is an invitation to paste the wrong one.
 */

import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { NotFoundError, ValidationError, ConflictError } from '../../core/errors/errors.js'
import { invalidateSubject } from '../../lib/authz/subject.js'
import { invalidateRosterForUser } from './roster.cache.js'
import type { MembershipInput, ProvisionUserDto } from './user.schema.js'

const BCRYPT_ROUNDS = 12

/** Everything safe to hand back about a provisioned account. */
const USER_VIEW = {
  id: true, email: true, fullName: true, status: true,
  organisationId: true, createdAt: true,
} as const

function assertAllowedOrg(organisationId: string, restrictToOrgId?: string): void {
  if (restrictToOrgId && organisationId !== restrictToOrgId) {
    throw new ValidationError({
      memberships: [`not permitted to grant access to organisation ${organisationId}`],
    })
  }
}

/**
 * Turn one membership request into rows.
 *
 * Validates that every id named actually belongs to the organisation it is
 * claimed for. Without this, a vehicle id from another tenant would be written
 * into a scope set and then trusted by every downstream filter.
 */
async function applyMembership(
  userId: string,
  input: MembershipInput,
  grantedById?: string,
  allowPlatformRoles = false,
): Promise<void> {
  const org = await prisma.organisation.findUnique({
    where: { id: input.organisationId }, select: { id: true },
  })
  if (!org) throw new NotFoundError(`Organisation ${input.organisationId}`)

  const allVehicles = input.allVehicles ?? true
  const vehicleIds      = input.vehicleIds ?? []
  const vehicleGroupIds = input.vehicleGroupIds ?? []

  if (!allVehicles && vehicleIds.length === 0 && vehicleGroupIds.length === 0) {
    // A restricted membership naming nothing sees nothing. That is a legal
    // state the resolver handles, but as a REQUEST it is almost certainly a
    // mistake, and one that presents as "the map is broken".
    throw new ValidationError({
      memberships: [`${input.organisationId}: allVehicles is false but no vehicles or groups were named — that grants sight of nothing`],
    })
  }

  if (vehicleIds.length) {
    const found = await prisma.vehicle.count({
      where: { id: { in: vehicleIds }, organisationId: org.id },
    })
    if (found !== new Set(vehicleIds).size) {
      throw new ValidationError({
        memberships: [`${input.organisationId}: one or more vehicleIds do not belong to this organisation`],
      })
    }
  }
  if (vehicleGroupIds.length) {
    const found = await prisma.vehicleGroup.count({
      where: { id: { in: vehicleGroupIds }, organisationId: org.id },
    })
    if (found !== new Set(vehicleGroupIds).size) {
      throw new ValidationError({
        memberships: [`${input.organisationId}: one or more vehicleGroupIds do not belong to this organisation`],
      })
    }
  }

  // Roles are resolved by slug WITHIN this organisation, plus the platform
  // roles, which belong to none.
  const roleSlugs = input.roleSlugs ?? []
  const roles = roleSlugs.length
    ? await prisma.role.findMany({
        where: {
          slug: { in: roleSlugs },
          OR: [{ organisationId: org.id }, { organisationId: null }],
        },
        select: { id: true, slug: true, organisationId: true },
      })
    : []

  const missing = roleSlugs.filter((s) => !roles.some((r) => r.slug === s))
  if (missing.length) {
    throw new NotFoundError(`Role(s) ${missing.join(', ')} in this organisation`)
  }

  // A platform role reaches every tenant, so granting one is not an
  // organisation-level act and an org admin must not be able to do it.
  //
  // An EXPLICIT capability, not inferred from restrictToOrgId. It was inferred
  // once, and the inference broke the moment the org route learned to grant
  // several organisations at once: that path has to drop restrictToOrgId (it
  // is granting more than one org, each checked separately), which silently
  // re-permitted platform roles on a route that must never allow them.
  //
  // "Which organisations may I touch" and "may I hand out a platform role" are
  // two different questions and are now two different arguments.
  const platformRoles = roles.filter((r) => r.organisationId === null)
  if (platformRoles.length && !allowPlatformRoles) {
    // Left to the dedicated platform path, which checks `platform:admin`.
    throw new ValidationError({
      memberships: [`${platformRoles.map((r) => r.slug).join(', ')} are platform roles and cannot be granted through an organisation`],
    })
  }

  const membership = await prisma.orgMembership.upsert({
    where:  { userId_organisationId: { userId, organisationId: org.id } },
    create: { userId, organisationId: org.id, allVehicles, createdById: grantedById ?? null },
    update: { allVehicles, revokedAt: null },
    select: { id: true },
  })

  // The scope is REPLACED, not merged: a caller sending a narrower list means
  // to narrow it, and merging would make it impossible to take a vehicle away.
  await prisma.membershipVehicleScope.deleteMany({ where: { membershipId: membership.id } })
  if (!allVehicles) {
    await prisma.membershipVehicleScope.createMany({
      data: [...new Set(vehicleIds)].map((vehicleId) => ({ membershipId: membership.id, vehicleId })),
      skipDuplicates: true,
    })
    await prisma.membershipVehicleScope.createMany({
      data: [...new Set(vehicleGroupIds)].map((vehicleGroupId) => ({ membershipId: membership.id, vehicleGroupId })),
      skipDuplicates: true,
    })
  }

  // Roles are likewise set to exactly what was asked for, within this org.
  const orgRoleIds = roles.map((r) => r.id)
  const existing = await prisma.userRole.findMany({
    where:  { userId, revokedAt: null, role: { organisationId: org.id } },
    select: { id: true, roleId: true },
  })
  const toRevoke = existing.filter((e) => !orgRoleIds.includes(e.roleId)).map((e) => e.id)
  const toGrant  = orgRoleIds.filter((id) => !existing.some((e) => e.roleId === id))

  if (toRevoke.length) {
    await prisma.userRole.updateMany({ where: { id: { in: toRevoke } }, data: { revokedAt: new Date() } })
  }
  for (const roleId of toGrant) {
    await prisma.userRole.create({ data: { userId, roleId, assignedById: grantedById ?? null } })
  }
}

/**
 * Create an account, or attach new access to one that already exists.
 *
 * Email is the identity. Provisioning the same address twice ADDS the named
 * memberships rather than failing, which is what "give Ada access to Menengai
 * as well" looks like from the caller's side.
 */
export async function provisionUser(
  dto: ProvisionUserDto,
  opts: { restrictToOrgId?: string; grantedById?: string; allowPlatformRoles?: boolean } = {},
) {
  if (dto.memberships.length === 0) {
    throw new ValidationError({
      memberships: ['a user must be given at least one organisation'],
    })
  }
  for (const m of dto.memberships) assertAllowedOrg(m.organisationId, opts.restrictToOrgId)

  const existing = await prisma.user.findFirst({
    where:  { email: dto.email },
    select: { id: true, deletedAt: true },
  })

  if (existing?.deletedAt) {
    throw new ConflictError('An account with this email was removed; restore it rather than recreating it')
  }

  let userId: string
  // Whether this call CREATED the account, and whether it could already sign
  // in. The invite path needs both: inviting somebody whose account already
  // has a password is an account-takeover vector via a guessed email address,
  // and "created" is the difference between "we made an account" and "we added
  // an existing person to your organisation" — two different things to tell an
  // admin.
  const created = !existing
  let hadPassword = false
  if (existing) {
    userId = existing.id
    const before = await prisma.user.findUnique({
      where: { id: userId }, select: { passwordHash: true },
    })
    hadPassword = Boolean(before?.passwordHash)
    if (dto.password) {
      await prisma.user.update({
        where: { id: userId },
        data:  { passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS) },
      })
    }
  } else {
    // `users.organisation_id` is NOT NULL and means who EMPLOYS this person.
    // The first membership named is the natural answer; access comes from the
    // memberships, not from this column.
    const homeOrgId = dto.memberships[0]!.organisationId
    const created = await prisma.user.create({
      data: {
        email:          dto.email,
        fullName:       dto.fullName,
        phone:          dto.phone ?? null,
        employeeId:     dto.employeeId ?? null,
        organisationId: homeOrgId,
        status:         'ACTIVE',
        passwordHash:   dto.password ? await bcrypt.hash(dto.password, BCRYPT_ROUNDS) : null,
      },
      select: { id: true },
    })
    userId = created.id
  }

  for (const m of dto.memberships) {
    await applyMembership(userId, m, opts.grantedById, opts.allowPlatformRoles ?? false)
  }

  // The resolver caches for five minutes. Without this a fresh grant looks like
  // it did not take, and the natural response is to grant it again.
  await invalidateSubject(userId)
  // Same argument, one layer up: the admin who just created this person is
  // about to look at the roster they are supposed to be in. The organisations
  // named in the request are passed explicitly because a brand-new membership
  // is not yet resolvable from the user row.
  await invalidateRosterForUser(userId, ...dto.memberships.map((m) => m.organisationId))

  const user = await prisma.user.findUnique({ where: { id: userId }, select: USER_VIEW })
  return { user, created, hadPassword }
}

/** Set one organisation's membership and roles for an existing user. */
export async function setMembership(
  userId: string,
  input: MembershipInput,
  opts: { restrictToOrgId?: string; grantedById?: string; allowPlatformRoles?: boolean } = {},
) {
  assertAllowedOrg(input.organisationId, opts.restrictToOrgId)
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } })
  if (!user) throw new NotFoundError('User')

  await applyMembership(userId, input, opts.grantedById, opts.allowPlatformRoles ?? false)
  await invalidateSubject(userId)
  await invalidateRosterForUser(userId, input.organisationId)
  return listMemberships(userId)
}

/**
 * Withdraw access to one organisation.
 *
 * Soft: the membership is stamped revoked and the roles held there are revoked
 * with it, so the access history survives. `resolveSubject` only ever reads
 * live rows, so this takes effect on the next resolution.
 */
/**
 * Keep `User.organisationId` among the organisations the person can actually
 * reach.
 *
 * ## The divergence this closes
 *
 * `organisationId` records who EMPLOYS somebody and was set once, at creation,
 * and never revisited. Memberships are what they may reach, and those come and
 * go. Nothing kept the two in step, so somebody granted four organisations and
 * later removed from three kept a home organisation naming one of the three
 * they had lost — and the account page said so, printing "Home organisation:
 * Kabras" directly above an Organisations list that did not contain Kabras.
 * Two facts about one person, on one screen, disagreeing.
 *
 * ## What it does NOT do
 *
 * It never clears the column, and it never touches somebody with no
 * memberships at all. `organisationId` is NOT NULL, and the accounts that have
 * no membership are the ~549 synced from the driver registry — their home
 * organisation is the only organisation they have, it is what the analytics
 * roster reads, and there is nothing to reconcile it against. So: only when
 * the home organisation has just been revoked, and only when somewhere else
 * remains to move it to.
 *
 * The OLDEST surviving membership wins. Deterministic, so a repair pass and a
 * live revoke reach the same answer, and defensible: the one they have held
 * longest is the likeliest employer of the ones left.
 */
async function rehomeIfNeeded(userId: string, revokedOrgId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { organisationId: true },
  })
  // Their home is elsewhere; losing this organisation says nothing about it.
  if (!user || user.organisationId !== revokedOrgId) return

  const survivor = await prisma.orgMembership.findFirst({
    where:   { userId, revokedAt: null },
    orderBy: { createdAt: 'asc' },
    select:  { organisationId: true },
  })
  // Nowhere to move it to. The column is NOT NULL, and a stale home is a
  // better record than a lie — they did work there.
  if (!survivor) return

  await prisma.user.update({
    where: { id: userId },
    data:  { organisationId: survivor.organisationId },
  })
  logger.info(
    { userId, from: revokedOrgId, to: survivor.organisationId },
    'membership: home organisation followed the revoke',
  )
}

export async function revokeMembership(
  userId: string,
  organisationId: string,
  opts: { restrictToOrgId?: string } = {},
) {
  assertAllowedOrg(organisationId, opts.restrictToOrgId)

  const membership = await prisma.orgMembership.findUnique({
    where:  { userId_organisationId: { userId, organisationId } },
    select: { id: true, revokedAt: true },
  })
  if (!membership || membership.revokedAt) throw new NotFoundError('Membership')

  const now = new Date()
  await prisma.orgMembership.update({ where: { id: membership.id }, data: { revokedAt: now } })
  await prisma.userRole.updateMany({
    where: { userId, revokedAt: null, role: { organisationId } },
    data:  { revokedAt: now },
  })

  // Before the cache work below, so the rosters retired there already reflect
  // the new home organisation rather than needing a second pass.
  await rehomeIfNeeded(userId, organisationId)

  await invalidateSubject(userId)
  // The membership is already revoked, so this organisation no longer resolves
  // from the user row — it has to be named, or the roster it just left keeps
  // showing them.
  await invalidateRosterForUser(userId, organisationId)
  return listMemberships(userId)
}

export async function listMemberships(userId: string) {
  const [memberships, grants] = await Promise.all([
    prisma.orgMembership.findMany({
      where:  { userId, revokedAt: null },
      select: {
        organisationId: true,
        allVehicles:    true,
        organisation:   { select: { name: true, code: true } },
        vehicleScopes:  { select: { vehicleId: true, vehicleGroupId: true } },
      },
    }),
    prisma.userRole.findMany({
      where:  { userId, revokedAt: null },
      select: { role: { select: { slug: true, name: true, organisationId: true } } },
    }),
  ])

  return memberships.map((m) => ({
    organisationId: m.organisationId,
    name:           m.organisation.name,
    code:           m.organisation.code,
    allVehicles:    m.allVehicles,
    vehicleIds:      m.vehicleScopes.map((s) => s.vehicleId).filter(Boolean),
    vehicleGroupIds: m.vehicleScopes.map((s) => s.vehicleGroupId).filter(Boolean),
    roles: grants
      .filter((g) => g.role.organisationId === m.organisationId)
      .map((g) => ({ slug: g.role.slug, name: g.role.name })),
  }))
}
