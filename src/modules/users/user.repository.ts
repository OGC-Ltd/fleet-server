import { prisma } from '../../lib/prisma.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery } from './user.schema.js'
import { UNSCOPED, groupWhere, type GroupScope } from './user-group.scope.js'

const selectUser = (orgId: string) => ({
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
  // Group memberships are part of the roster so administrators can see and
  // manage the same access boundary used to narrow it.
  groups: {
    where: { group: { organisationId: orgId } },
    select: { group: { select: { id: true, slug: true, name: true } } },
  },
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
})

function withGroupAliases<T extends { groups: { group: { id: string; slug: string; name: string } }[] }>(user: T) {
  const groups = user.groups
    .map(({ group }) => group)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { ...user, groups, group: groups[0] ?? null }
}

/**
 * The roster's filter, built once and used by both the page and the count.
 *
 * Extracted rather than duplicated because `countForScope` below has to ask
 * the SAME question under a different group scope, and a shadow report
 * measured against a subtly different filter would report a number nobody
 * could act on.
 */
function rosterWhere(orgId: string, { status, access }: ListUserQuery, scope: GroupScope) {
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

  /**
   * The GROUP narrowing, and why it rides with `access === 'system'`.
   *
   * It applies to the administration roster and to nothing else. That roster
   * is already the invited/can-sign-in set, which is the handful of real
   * logins; the unfiltered roster is overwhelmingly accounts synced from the
   * driver registry, who carry no email and so can never be placed in a
   * group. Narrowing that list by group would empty it, and would take the
   * drivers page, the PDF export and the live map's driver name with it.
   *
   * So the rule is stated where it is true: an administrator administers
   * their own group's PEOPLE WHO CAN LOG IN. See user-group.scope.
   */
  return {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(access === 'system'
      ? { AND: [reachable, invited], ...groupWhere(scope) }
      : reachable),
  }
}

/** How many rows this roster holds under a DIFFERENT scope — the shadow report. */
export async function countForScope(orgId: string, query: ListUserQuery, scope: GroupScope) {
  return prisma.user.count({ where: rosterWhere(orgId, query, scope) })
}

export async function findAll(
  orgId: string,
  query: ListUserQuery,
  scope: GroupScope = UNSCOPED,
) {
  const { page, limit } = query
  const skip  = (page - 1) * limit
  const where = rosterWhere(orgId, query, scope)

  const [data, total] = await prisma.$transaction([
    prisma.user.findMany({ where, skip, take: limit, select: selectUser(orgId), orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ])
  return { data: data.map(withGroupAliases), total }
}

/**
 * Is this person visible to this organisation at all?
 *
 * The same reachability `findMany` uses for the roster — HOME ORGANISATION OR
 * A LIVE MEMBERSHIP — and it exists because `findById` below uses only the
 * first of those. That asymmetry is a real defect with a visible symptom: a
 * visiting member is listed by the roster and then not found by anything that
 * looks them up, so the screen offers an action against a row the server will
 * swear does not exist.
 *
 * Deliberately NOT a widening of `findById`. The routes that use findById also
 * EDIT the user's global record — name, phone, roles — and letting a host
 * organisation rename somebody whose account lives in another tenant is a
 * different decision from letting it SEE them, and not one to make as a side
 * effect of fixing a delete. See the note in purgeUser.
 */
export async function findReachable(orgId: string, userId: string, scope: GroupScope = UNSCOPED) {
  return prisma.user.findFirst({
    where: {
      id: userId,
      deletedAt: null,
      // Same group as the caller, when the caller is scoped. Here as well as
      // on the roster because a row this cannot find is a row the mutations
      // above refuse to touch — otherwise the list is narrowed and the id is
      // still good, which is a filter rather than a rule.
      ...groupWhere(scope),
      OR: [
        { organisationId: orgId },
        { memberships: { some: { organisationId: orgId, revokedAt: null } } },
      ],
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      organisationId: true,
      groups: {
        where: { group: { organisationId: orgId } },
        select: { groupId: true },
      },
    },
  })
}

export async function findById(orgId: string, userId: string, scope: GroupScope = UNSCOPED) {
  const user = await prisma.user.findFirst({
    where: { id: userId, organisationId: orgId, deletedAt: null, ...groupWhere(scope) },
    select: {
      ...selectUser(orgId),
      userRoles: {
        where: { revokedAt: null },
        select: { id: true, assignedAt: true, role: { select: { id: true, name: true, slug: true } } },
      },
    },
  })
  return user ? withGroupAliases(user) : null
}

export async function create(orgId: string, dto: CreateUserDto) {
  return prisma.user.create({
    data: { ...dto, organisationId: orgId },
    select: selectUser(orgId),
  }).then(withGroupAliases)
}

export async function update(orgId: string, userId: string, dto: UpdateUserDto) {
  // Group membership is managed through the dedicated user-groups routes.
  return prisma.user.update({
    where: { id: userId, organisationId: orgId },
    data: dto,
    select: selectUser(orgId),
  }).then(withGroupAliases)
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

/**
 * Everything about this person that a permanent delete would take with them.
 *
 * Read BEFORE the delete, and read as counts rather than rows, because it is
 * the answer to a question the administrator is entitled to ask first: what am
 * I about to destroy. Two of these lists are checked and the rest are only
 * reported — see `purge` for which, and why.
 */
export async function countBelongings(userId: string) {
  const [
    orgIds, roles, sessions, invites, assignments,
    trips, thefts, violations, speeding, pushes,
  ] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: userId },
      select: {
        organisationId: true,
        memberships: { where: { revokedAt: null }, select: { organisationId: true } },
      },
    }),
    prisma.userRole.count({ where: { userId } }),
    prisma.authSession.count({ where: { userId } }),
    prisma.passwordToken.count({ where: { userId } }),
    prisma.vehicleAssignment.count({ where: { userId } }),
    prisma.trip.count({ where: { driverId: userId } }),
    prisma.fuelTheft.count({ where: { driverId: userId } }),
    prisma.geofenceViolation.count({ where: { driverId: userId } }),
    prisma.speedingIncident.count({ where: { driverId: userId } }),
    prisma.pushSubscription.count({ where: { userId } }),
  ])

  return {
    organisationIds: orgIds
      ? [orgIds.organisationId, ...orgIds.memberships.map((m) => m.organisationId)]
      : [],
    roles, sessions, invites, assignments,
    trips, thefts, violations, speeding, pushes,
    // What makes this person a DRIVER rather than a dashboard account. These
    // rows outlive the person on purpose — a trip that happened, happened —
    // and their foreign keys are nullable so the database would happily blank
    // the driver out of every one of them. The service refuses instead.
    operational: trips + thefts + violations + speeding + assignments,
  }
}

/**
 * Delete the person and the access that only exists to describe them.
 *
 * ## What goes, and why it goes in this order
 *
 * Four tables hold a REQUIRED reference to a user, so Postgres refuses the
 * delete while any row survives — role grants, organisation memberships,
 * sign-in sessions, and (through a cascade) invitation tokens and push
 * subscriptions. All four are statements about who this account is; none of
 * them is a record of something that happened in the fleet. They are deleted
 * first, in one transaction, so a failure half way leaves the account intact
 * rather than stripped of its access and still there.
 *
 * Rows that merely NAME this person as an actor — who granted a membership,
 * who created an API key, who assigned a geofence — carry a nullable key and
 * are blanked by the database's own ON DELETE SET NULL. That is the right
 * outcome: the grant still happened, and "granted by somebody since deleted"
 * is the honest reading of it.
 *
 * ## Why this is not `deleteMany` on the user
 *
 * `where: { id, organisationId }` scopes the delete to the organisation the
 * caller is administering. A person's HOME organisation is the only one this
 * can be, which is checked in the service — deleting somebody through an org
 * they are merely a guest of would be deleting them everywhere from a page
 * that says one site's name at the top.
 */
export async function purge(orgId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.userRole.deleteMany({ where: { userId } })
    await tx.orgMembership.deleteMany({ where: { userId } })
    await tx.authSession.deleteMany({ where: { userId } })
    return tx.user.delete({ where: { id: userId, organisationId: orgId } })
  })
}
