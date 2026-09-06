import { NotFoundError, ConflictError } from '../../core/errors/errors.js'
import * as repo from './user.repository.js'
import { readRoster, writeRoster, invalidateRoster, invalidateRosterForUser } from './roster.cache.js'
import type { CreateUserDto, UpdateUserDto, ListUserQuery, AssignRoleDto } from './user.schema.js'

type Roster = Awaited<ReturnType<typeof repo.findAll>>

/**
 * The roster, from Redis when it is warm and from Postgres when it is not.
 *
 * Every narrowing the caller can apply goes into the variant, because two
 * queries that differ by page or by status filter are two different answers
 * and must not share a key.
 *
 * Dates arrive back from JSON as strings rather than Date objects. That is
 * fine and deliberate here: this value is serialised to JSON on its way out to
 * the client anyway, so the cached round trip produces the same response body
 * as the database one. Nothing between here and the wire does date arithmetic.
 */
export async function listUsers(orgId: string, query: ListUserQuery) {
  const variant = `${query.page}:${query.limit}:${query.status ?? 'all'}:${query.access ?? 'all'}`

  const cached = await readRoster<Roster>(orgId, variant)
  if (cached) return cached

  const fresh = await repo.findAll(orgId, query)
  await writeRoster(orgId, variant, fresh)
  return fresh
}

export async function getUser(orgId: string, userId: string) {
  const user = await repo.findById(orgId, userId)
  if (!user) throw new NotFoundError('User')
  return user
}

export async function createUser(orgId: string, dto: CreateUserDto) {
  const user = await repo.create(orgId, dto)
  await invalidateRoster(orgId)
  return user
}

export async function updateUser(orgId: string, userId: string, dto: UpdateUserDto) {
  await getUser(orgId, userId) // ensure exists + correct org
  const user = await repo.update(orgId, userId, dto)
  // Every roster they appear in, not just this one — a renamed person is
  // renamed everywhere they have access.
  await invalidateRosterForUser(userId, orgId)
  return user
}

export async function deleteUser(orgId: string, userId: string) {
  await getUser(orgId, userId)
  // Read their organisations BEFORE the delete: afterwards the row is gone
  // from the roster's point of view and there is nothing left to resolve.
  await invalidateRosterForUser(userId, orgId)
  return repo.softDelete(orgId, userId)
}

export async function assignRoleToUser(orgId: string, userId: string, dto: AssignRoleDto, assignedById?: string) {
  await getUser(orgId, userId)
  try {
    const assigned = await repo.assignRole(userId, dto.roleId, assignedById)
    await invalidateRosterForUser(userId, orgId)
    return assigned
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
  await invalidateRosterForUser(userId, orgId)
  return result
}
