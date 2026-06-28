import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './role.repository.js'
import type { CreateRoleDto, UpdateRoleDto, PermissionAssignDto, ListQuery } from './role.schema.js'

export async function listRoles(orgId: string, query: ListQuery) {
  return repo.findAll(orgId, query)
}

export async function getRole(orgId: string, roleId: string) {
  const role = await repo.findById(orgId, roleId)
  if (!role) throw new NotFoundError('Role')
  return role
}

export async function createRole(orgId: string, dto: CreateRoleDto) {
  return repo.create(orgId, dto)
}

export async function updateRole(orgId: string, roleId: string, dto: UpdateRoleDto) {
  await getRole(orgId, roleId)
  return repo.update(orgId, roleId, dto)
}

export async function deleteRole(orgId: string, roleId: string) {
  await getRole(orgId, roleId)
  return repo.remove(orgId, roleId)
}

export async function addPermissionToRole(orgId: string, roleId: string, dto: PermissionAssignDto) {
  await getRole(orgId, roleId)
  return repo.addPermission(roleId, dto.permissionId)
}

export async function removePermissionFromRole(orgId: string, roleId: string, permissionId: string) {
  await getRole(orgId, roleId)
  return repo.removePermission(roleId, permissionId)
}

export async function listPermissions(query: ListQuery) {
  return repo.listPermissions(query.page, query.limit)
}
