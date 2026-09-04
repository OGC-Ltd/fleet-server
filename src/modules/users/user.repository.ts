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
}

export async function findAll(orgId: string, { page, limit, status }: ListUserQuery) {
  const skip = (page - 1) * limit
  const where = { organisationId: orgId, deletedAt: null, ...(status ? { status } : {}) }
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
