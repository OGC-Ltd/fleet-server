import { prisma } from '../../lib/prisma.js'
import type { CreateRoleDto, UpdateRoleDto, ListQuery } from './role.schema.js'

const WITH_PERMISSIONS = {
  permissions: {
    select: { permission: { select: { id: true, name: true, slug: true, resource: true, action: true } } },
  },
}

export async function findAll(orgId: string, { page, limit }: ListQuery) {
  const skip = (page - 1) * limit
  const where = { organisationId: orgId }
  const [data, total] = await prisma.$transaction([
    prisma.role.findMany({ where, skip, take: limit, include: WITH_PERMISSIONS, orderBy: { createdAt: 'asc' } }),
    prisma.role.count({ where }),
  ])
  return { data, total }
}

export async function findById(orgId: string, roleId: string) {
  return prisma.role.findFirst({ where: { id: roleId, organisationId: orgId }, include: WITH_PERMISSIONS })
}

export async function create(orgId: string, dto: CreateRoleDto) {
  return prisma.role.create({ data: { ...dto, organisationId: orgId }, include: WITH_PERMISSIONS })
}

export async function update(orgId: string, roleId: string, dto: UpdateRoleDto) {
  return prisma.role.update({ where: { id: roleId, organisationId: orgId }, data: dto, include: WITH_PERMISSIONS })
}

export async function remove(orgId: string, roleId: string) {
  return prisma.role.delete({ where: { id: roleId, organisationId: orgId } })
}

export async function addPermission(roleId: string, permissionId: string) {
  return prisma.rolePermission.create({ data: { roleId, permissionId } })
}

export async function removePermission(roleId: string, permissionId: string) {
  return prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId, permissionId } } })
}

export async function listPermissions(page: number, limit: number) {
  const skip = (page - 1) * limit
  const [data, total] = await prisma.$transaction([
    prisma.permission.findMany({ skip, take: limit, orderBy: [{ resource: 'asc' }, { action: 'asc' }] }),
    prisma.permission.count(),
  ])
  return { data, total }
}
