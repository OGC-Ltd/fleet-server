import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors/errors.js'
import { sendSuccess } from '../../core/response/response.js'
import { prisma } from '../../lib/prisma.js'
import { invalidateSubject } from '../../lib/authz/subject.js'
import { groupScopeFor } from './user-group.scope.js'
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
    where: { id: groupId, ...(organisationId ? { organisationId } : {}) },
    select: { id: true, organisationId: true, users: { select: { userId: true } } },
  })
  if (!group) throw new NotFoundError('User group')
  return group
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

async function assertUserInGroupScope(
  req: Parameters<RequestHandler>[0],
  userId: string,
  organisationId: string,
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
        where: { group: { organisationId } },
        select: { groupId: true },
      },
    },
  })
  if (!user) throw new NotFoundError('User')
  if (!user.groups.some(({ groupId }) => scope.groupIds.includes(groupId))) {
    throw new ForbiddenError('You can only change group memberships for users in your groups')
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
    const groups = await prisma.userGroup.findMany({
      where: organisationId ? { organisationId } : {},
      orderBy: { name: 'asc' },
      select: {
        id: true,
        organisationId: true,
        slug: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { users: true } },
      },
    })
    sendSuccess(res, groups)
  } catch (err) { next(err) }
}

export const create: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as CreateUserGroupDto
    const pathOrgId = orgIdFor(req)
    if (pathOrgId && dto.organisationId && dto.organisationId !== pathOrgId) {
      throw new BadRequestError('Organisation in the request must match the route')
    }
    const organisationId = pathOrgId ?? dto.organisationId
    if (!organisationId) throw new BadRequestError('organisationId is required')

    const organisation = await prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { id: true },
    })
    if (!organisation) throw new NotFoundError('Organisation')

    const group = await prisma.userGroup.create({
      data: {
        organisationId,
        slug: slugFromName(dto.name),
        name: dto.name,
        description: dto.description ?? null,
      },
    })
    sendSuccess(res, group, 201)
  } catch (err) { next(err) }
}

export const update: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as UpdateUserGroupDto
    const group = await groupFor(param(req, 'groupId'), orgIdFor(req))
    const updated = await prisma.userGroup.update({
      where: { id: group.id },
      data: dto,
    })
    await invalidateRostersForUsers(group.users.map(({ userId }) => userId))
    sendSuccess(res, updated)
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    const group = await groupFor(param(req, 'groupId'), orgIdFor(req))
    await prisma.userGroup.delete({ where: { id: group.id } })
    await refreshUsers(group.users.map(({ userId }) => userId))
    sendSuccess(res, { id: group.id, removed: true })
  } catch (err) { next(err) }
}

export const addUser: RequestHandler = async (req, res, next) => {
  try {
    const group = await groupFor(param(req, 'groupId'), orgIdFor(req))
    const userId = param(req, 'userId')
    await userInOrganisation(userId, group.organisationId)
    await assertUserInGroupScope(req, userId, group.organisationId)

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
    await userInOrganisation(userId, group.organisationId)
    await assertUserInGroupScope(req, userId, group.organisationId)

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
    if (organisationId) await assertUserInGroupScope(req, userId, organisationId)

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
          organisationId: { in: allowedOrganisationIds },
        },
        select: { id: true, organisationId: true, slug: true, name: true },
      })
      if (groups.length !== groupIds.length) throw new NotFoundError('User group')

      await tx.userGroupMembership.deleteMany({
        where: {
          userId,
          ...(organisationId ? { group: { organisationId } } : {}),
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
