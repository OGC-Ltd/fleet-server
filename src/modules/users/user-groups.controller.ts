import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors/errors.js'
import { sendSuccess } from '../../core/response/response.js'
import { prisma } from '../../lib/prisma.js'
import { can, canReachOrg, invalidateSubject, resolveSubject } from '../../lib/authz/subject.js'
import { canEditUser } from './user.authz.js'
import { groupScopeFor, prospectiveScope } from './user-group.scope.js'
import { invalidateRosterForUser, invalidateRostersForUsers } from './roster.cache.js'
import type {
  CreateUserGroupDto,
  SetUserGroupsDto,
  UpdateUserGroupDto,
} from './user-groups.schema.js'

const param = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string
const orgIdFor = (req: Parameters<RequestHandler>[0]) => req.params['orgId'] as string | undefined

function slugFromName(name: string): string {
  const slug = name.trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || `group-${randomUUID()}`
}

async function groupFor(groupId: string, organisationId?: string) {
  const group = await prisma.userGroup.findFirst({
    where: {
      id: groupId,
      ...(organisationId ? { organisations: { some: { organisationId } } } : {}),
    },
    select: {
      id: true,
      organisationId: true,
      slug: true,
      organisations: { select: { organisationId: true } },
      users: { select: { userId: true } },
    },
  })
  if (!group) throw new NotFoundError('User group')
  return { ...group, organisationIds: group.organisations.map(({ organisationId: id }) => id) }
}

async function assertManageOrganisations(userId: string, organisationIds: string[]): Promise<void> {
  const subject = await resolveSubject(userId)
  const forbidden = organisationIds.filter((id) =>
    !canReachOrg(subject, id) || !can(subject, id, 'user:assign_role'));
  if (forbidden.length > 0) throw new ForbiddenError('Missing permission: user:assign_role')

  const existing = await prisma.organisation.findMany({
    where: { id: { in: organisationIds } },
    select: { id: true },
  })
  if (existing.length !== organisationIds.length) throw new NotFoundError('Organisation')
}

async function userInOrganisation(userId: string, organisationId: string) {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      deletedAt: null,
      OR: [
        { organisationId },
        { memberships: { some: { organisationId, revokedAt: null } } },
      ],
    },
    select: { id: true },
  })
  if (!user) throw new NotFoundError('User')
}

async function assertGroupInScope(
  req: Parameters<RequestHandler>[0],
  groupId: string,
  organisationId: string,
): Promise<void> {
  const scope = await groupScopeFor(req.user?.id, organisationId)
  if (!scope.unscoped && !scope.groupIds.includes(groupId)) {
    throw new ForbiddenError('You can only manage groups you belong to')
  }
}

async function assertUserInGroupScope(
  req: Parameters<RequestHandler>[0],
  userId: string,
  organisationId: string,
  allowUngrouped = false,
): Promise<void> {
  const scope = await groupScopeFor(req.user?.id, organisationId)
  if (scope.unscoped) return

  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      deletedAt: null,
      OR: [
        { organisationId },
        { memberships: { some: { organisationId, revokedAt: null } } },
      ],
    },
    select: {
      groups: {
        where: { group: { organisations: { some: { organisationId } } } },
        select: { groupId: true },
      },
    },
  })
  if (!user) throw new NotFoundError('User')
  if (allowUngrouped && user.groups.length === 0) return
  if (!user.groups.some(({ groupId }) => scope.groupIds.includes(groupId))) {
    throw new ForbiddenError('You can only change group memberships for users in your groups')
  }
}

async function assertGroupsInScope(
  req: Parameters<RequestHandler>[0],
  groupIds: string[],
  organisationId: string,
): Promise<void> {
  const scope = await groupScopeFor(req.user?.id, organisationId)
  if (!scope.unscoped && groupIds.some((id) => !scope.groupIds.includes(id))) {
    throw new ForbiddenError('You can only assign users to groups you belong to')
  }
}

async function assertUserEditable(
  req: Parameters<RequestHandler>[0],
  userId: string,
  organisationId: string,
): Promise<void> {
  const verdict = await canEditUser(req.user!.id, userId, organisationId)
  if (!verdict.ok) {
    throw new ForbiddenError(`You cannot edit a ${verdict.blockedBy} account`)
  }
}

async function refreshUser(userId: string): Promise<void> {
  await Promise.all([
    invalidateSubject(userId),
    invalidateRosterForUser(userId),
  ])
}

async function refreshUsers(userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)]
  await Promise.all([
    invalidateRostersForUsers(ids),
    ...ids.map(invalidateSubject),
  ])
}

export const list: RequestHandler = async (req, res, next) => {
  try {
    const organisationId = orgIdFor(req)
    // Group visibility is access control, so it must not follow roster shadow mode.
    const scope = organisationId
      ? await prospectiveScope(req.user?.id, organisationId)
      : null
    const groups = await prisma.userGroup.findMany({
      where: organisationId
        ? {
            organisations: { some: { organisationId } },
            ...(scope && !scope.unscoped ? { id: { in: scope.groupIds } } : {}),
          }
        : {},
      orderBy: { name: 'asc' },
      select: {
        id: true,
        organisationId: true,
        organisations: { select: { organisationId: true } },
        slug: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { users: true } },
      },
    })
    sendSuccess(res, groups.map((group) => ({
      ...group,
      organisationIds: group.organisations.map(({ organisationId: id }) => id),
    })))
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as CreateUserGroupDto
    const pathOrgId = orgIdFor(req)
    const organisationIds = dto.organisationIds
      ?? [dto.organisationId ?? pathOrgId].filter((id): id is string => !!id)
    if (organisationIds.length === 0) throw new BadRequestError('At least one organisation is required')
    if (pathOrgId && !organisationIds.includes(pathOrgId)) {
      throw new BadRequestError('The route organisation must be included in organisationIds')
    }
    await assertManageOrganisations(req.user!.id, organisationIds)
    const organisationId = pathOrgId ?? organisationIds[0]

    const group = await prisma.userGroup.create({
      data: {
        organisationId,
        slug: slugFromName(dto.name),
        name: dto.name,
        description: dto.description ?? null,
        organisations: {
          create: organisationIds.map((id) => ({ organisationId: id })),
        },
      },
    })
    sendSuccess(res, { ...group, organisationIds }, 201)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as UpdateUserGroupDto
    const group = await groupFor(param(req, 'groupId'), orgIdFor(req))
    await assertGroupInScope(req, group.id, orgIdFor(req) ?? group.organisationId)
    const { organisationIds: requestedIds, ...fields } = dto
    let organisationIds = group.organisationIds
    let ownerOrganisationId = group.organisationId
    if (requestedIds) {
      await assertManageOrganisations(req.user!.id, requestedIds)
      const subject = await resolveSubject(req.user!.id)
      const retained = group.organisationIds.filter((id) =>
        !canReachOrg(subject, id) || !can(subject, id, 'user:assign_role'));
      organisationIds = [...new Set([...requestedIds, ...retained])]
      if (!organisationIds.includes(group.organisationId)) {
        const nextOwner = requestedIds[0]
        const slugConflict = await prisma.userGroup.findFirst({
          where: { organisationId: nextOwner, slug: group.slug, id: { not: group.id } },
          select: { id: true },
        })
        if (slugConflict) throw new BadRequestError('A group with this name already exists in the selected organisation')
        ownerOrganisationId = nextOwner
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.userGroup.update({
        where: { id: group.id },
        data: { ...fields, organisationId: ownerOrganisationId },
      })
      if (requestedIds) {
        const keep = new Set(organisationIds)
        const removeIds = group.organisationIds.filter((id) => !keep.has(id))
        if (removeIds.length > 0) {
          await tx.userGroupOrganisation.deleteMany({
            where: { groupId: group.id, organisationId: { in: removeIds } },
          })
        }
        await tx.userGroupOrganisation.createMany({
          data: organisationIds.map((id) => ({ groupId: group.id, organisationId: id })),
          skipDuplicates: true,
        })
      }
      return result
    })
    await invalidateRostersForUsers(group.users.map(({ userId }) => userId))
    sendSuccess(res, { ...updated, organisationIds })
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    const group = await groupFor(param(req, 'groupId'), orgIdFor(req))
    await assertGroupInScope(req, group.id, orgIdFor(req) ?? group.organisationId)
    await prisma.userGroup.delete({ where: { id: group.id } })
    await refreshUsers(group.users.map(({ userId }) => userId))
    sendSuccess(res, { id: group.id, removed: true })
  } catch (err) { next(err) }
}

export const addUser: RequestHandler = async (req, res, next) => {
  try {
    const group = await groupFor(param(req, 'groupId'), orgIdFor(req))
    const userId = param(req, 'userId')
    const organisationId = orgIdFor(req) ?? group.organisationId
    await assertGroupInScope(req, group.id, organisationId)
    await userInOrganisation(userId, organisationId)
    await assertUserInGroupScope(req, userId, organisationId, true)
    await assertUserEditable(req, userId, organisationId)

    await prisma.userGroupMembership.createMany({
      data: [{ userId, groupId: group.id }],
      skipDuplicates: true,
    })
    await refreshUser(userId)
    sendSuccess(res, { userId, groupId: group.id })
  } catch (err) { next(err) }
}

export const removeUser: RequestHandler = async (req, res, next) => {
  try {
    const group = await groupFor(param(req, 'groupId'), orgIdFor(req))
    const userId = param(req, 'userId')
    const organisationId = orgIdFor(req) ?? group.organisationId
    await assertGroupInScope(req, group.id, organisationId)
    await userInOrganisation(userId, organisationId)
    await assertUserInGroupScope(req, userId, organisationId)
    await assertUserEditable(req, userId, organisationId)

    const result = await prisma.userGroupMembership.deleteMany({
      where: { userId, groupId: group.id },
    })
    await refreshUser(userId)
    sendSuccess(res, { userId, groupId: group.id, removed: result.count > 0 })
  } catch (err) { next(err) }
}

/** Replace memberships in this organisation, or all memberships for platform admins. */
export const setUserGroups: RequestHandler = async (req, res, next) => {
  try {
    const userId = param(req, 'userId')
    const organisationId = orgIdFor(req)
    const { groupIds } = req.body as SetUserGroupsDto
    const scope = organisationId
      ? await groupScopeFor(req.user?.id, organisationId)
      : null
    if (organisationId) {
      await assertUserInGroupScope(req, userId, organisationId, groupIds.length > 0)
      await assertGroupsInScope(req, groupIds, organisationId)
      await assertUserEditable(req, userId, organisationId)
    }

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: {
          id: userId,
          deletedAt: null,
          ...(organisationId
            ? {
                OR: [
                  { organisationId },
                  { memberships: { some: { organisationId, revokedAt: null } } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          organisationId: true,
          memberships: { where: { revokedAt: null }, select: { organisationId: true } },
        },
      })
      if (!user) throw new NotFoundError('User')

      const allowedOrganisationIds = organisationId
        ? [organisationId]
        : [...new Set([user.organisationId, ...user.memberships.map((m) => m.organisationId)])]
      const groups = await tx.userGroup.findMany({
        where: {
          id: { in: groupIds },
          organisations: { some: { organisationId: { in: allowedOrganisationIds } } },
        },
        select: { id: true, organisationId: true, slug: true, name: true },
      })
      if (groups.length !== groupIds.length) throw new NotFoundError('User group')

      await tx.userGroupMembership.deleteMany({
        where: {
          userId,
          ...(organisationId
            ? {
                group: { organisations: { some: { organisationId } } },
                ...(scope && !scope.unscoped ? { groupId: { in: scope.groupIds } } : {}),
              }
            : {}),
        },
      })
      if (groupIds.length > 0) {
        await tx.userGroupMembership.createMany({
          data: groupIds.map((groupId) => ({ userId, groupId })),
        })
      }
      return groups
    })

    await refreshUser(userId)
    sendSuccess(res, { userId, groups: result })
  } catch (err) { next(err) }
}
