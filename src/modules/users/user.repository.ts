import { prisma } from '../../lib/prisma.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery } from './user.schema.js'

const SELECT_USER = {
  id: true,
  organisationId: true,
  fullName: true,
  email: true,
  phone: true,
  licenceNumber: true,
  employeeId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  // The password history the account page and the admin roster both show.
  // `passwordChangedAt: null` on an account that has one means it was set
  // before this was recorded — distinct from an account that has no password
  // at all, which the roster tells apart by whether an invite is pending.
  passwordChangedAt: true,
  passwordChangeCount: true,
  // Roles held IN THIS organisation. The roster's whole job is showing who can
  // do what, and a list of names with no roles beside them does not.
  userRoles: {
    where: { revokedAt: null },
    select: { assignedAt: true, role: { select: { id: true, slug: true, name: true, organisationId: true } } },
  },
  // Which organisations this person actually reaches. The roster is scoped by
  // membership now, so it has to be able to say which ones — an admin removing
  // somebody from an organisation needs to see what they would be removing.
  memberships: {
    where:  { revokedAt: null },
    select: { organisationId: true, allVehicles: true, createdAt: true },
  },
  // Invitation metadata ONLY — never the hash. Latest first, one row: all the
  // roster needs is whether an invitation is outstanding, which separates
  // "invited, has not been back" from "set a password and is using it".
  passwordTokens: {
    where:   { purpose: 'INVITE' as const },
    select:  { createdAt: true, expiresAt: true, consumedAt: true, revokedAt: true },
    orderBy: { createdAt: 'desc' as const },
    take:    1,
  },
}

export async function findAll(orgId: string, { page, limit, status, access }: ListUserQuery) {
  const skip = (page - 1) * limit

  /**
   * "Invited to access the system" — either an invitation was issued for them,
   * or they can already sign in.
   *
   * An EXPIRED, consumed or revoked invitation still counts. Somebody invited
   * three weeks ago who never opened the link is exactly who an administrator
   * needs to see, so they can resend it; filtering on a live token would hide
   * the one case the roster exists to surface. The same goes for a SUSPENDED
   * account — status is a column to display, never a reason to omit a row,
   * because an admin who cannot see a suspended account cannot reinstate it.
   *
   * The second arm is narrow on purpose. It reads "can actually sign in", and
   * the only account in this deployment that holds a password without ever
   * having been invited is the seeded Super Admin, which an administrator must
   * be able to see. Accounts synced from the driver registry match neither arm
   * — no password was ever set and no invitation was ever sent — which is what
   * drops 549 of 553 rows without naming the registry or trusting externalId.
   */
  const invited = {
    OR: [
      { passwordTokens: { some: { purpose: 'INVITE' as const } } },
      { passwordHash: { not: null } },
    ],
  }

  /**
   * Reachable from this organisation, which is NOT the same as employed by it.
   *
   * `users.organisation_id` records who employs somebody and is fixed when the
   * account is created. Access is carried by `org_memberships`, and the two
   * diverge the moment anybody works across sites: a person employed by
   * Menengai and granted Kabras as well has one `organisation_id` and two
   * memberships. Scoping the roster to the column alone — which is what it did
   * — meant Kabras' administrator could grant that person access and then not
   * find them in their own roster, and could never take it back.
   */
  const reachable = {
    OR: [
      { organisationId: orgId },
      { memberships: { some: { organisationId: orgId, revokedAt: null } } },
    ],
  }

  const where = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(access === 'system' ? { AND: [reachable, invited] } : reachable),
  }
  const [data, total] = await prisma.$transaction([
    prisma.user.findMany({ where, skip, take: limit, select: SELECT_USER, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ])
  return { data, total }
}

export async function findById(orgId: string, userId: string) {
  return prisma.user.findFirst({
    where: { id: userId, organisationId: orgId, deletedAt: null },
    select: {
      ...SELECT_USER,
      userRoles: {
        where: { revokedAt: null },
        select: { id: true, assignedAt: true, role: { select: { id: true, name: true, slug: true } } },
      },
    },
  })
}

export async function create(orgId: string, dto: CreateUserDto) {
  return prisma.user.create({
    data: { ...dto, organisationId: orgId },
    select: SELECT_USER,
  })
}

export async function update(orgId: string, userId: string, dto: UpdateUserDto) {
  return prisma.user.update({
    where: { id: userId, organisationId: orgId },
    data: dto,
    select: SELECT_USER,
  })
}

export async function softDelete(orgId: string, userId: string) {
  return prisma.user.update({
    where: { id: userId, organisationId: orgId },
    data: { deletedAt: new Date() },
  })
}

export async function assignRole(userId: string, roleId: string, assignedById?: string) {
  return prisma.userRole.create({
    data: { userId, roleId, assignedById },
    select: { id: true, assignedAt: true, role: { select: { id: true, name: true, slug: true } } },
  })
}

export async function revokeRole(userId: string, roleId: string) {
  const active = await prisma.userRole.findFirst({ where: { userId, roleId, revokedAt: null } })
  if (!active) return null
  return prisma.userRole.update({
    where: { id: active.id },
    data: { revokedAt: new Date() },
  })
}
