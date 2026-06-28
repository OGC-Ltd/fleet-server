import { NotFoundError, ConflictError } from '../../core/errors/errors.js'
import * as repo from './user.repository.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery, AssignRoleDto } from './user.schema.js'

export async function listUsers(orgId: string, query: ListUserQuery) {
  return repo.findAll(orgId, query)
}

export async function getUser(orgId: string, userId: string) {
  const user = await repo.findById(orgId, userId)
  if (!user) throw new NotFoundError('User')
  return user
}

export async function createUser(orgId: string, dto: CreateUserDto) {
  return repo.create(orgId, dto)
}

export async function updateUser(orgId: string, userId: string, dto: UpdateUserDto) {
  await getUser(orgId, userId) // ensure exists + correct org
  return repo.update(orgId, userId, dto)
}

export async function deleteUser(orgId: string, userId: string) {
  await getUser(orgId, userId)
  return repo.softDelete(orgId, userId)
}

export async function assignRoleToUser(orgId: string, userId: string, dto: AssignRoleDto, assignedById?: string) {
  await getUser(orgId, userId)
  try {
    return await repo.assignRole(userId, dto.roleId, assignedById)
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      throw new ConflictError('Role already assigned to this user')
    }
    throw err
  }
}

export async function revokeRoleFromUser(orgId: string, userId: string, roleId: string) {
  await getUser(orgId, userId)
  const result = await repo.revokeRole(userId, roleId)
  if (!result) throw new NotFoundError('Active role assignment')
  return result
}
