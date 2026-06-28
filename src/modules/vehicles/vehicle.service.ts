import { NotFoundError, ConflictError } from '../../core/errors/errors.js'
import * as repo from './vehicle.repository.js'
import type { CreateGroupDto, UpdateGroupDto, CreateVehicleDto, UpdateVehicleDto, CreateAssignmentDto, ListQuery } from './vehicle.schema.js'

// ── Groups ──────────────────────────────────────────────────────────────────

export async function listGroups(orgId: string, page: number, limit: number) {
  return repo.findAllGroups(orgId, page, limit)
}

export async function getGroup(orgId: string, groupId: string) {
  const g = await repo.findGroupById(orgId, groupId)
  if (!g) throw new NotFoundError('Vehicle group')
  return g
}

export async function createGroup(orgId: string, dto: CreateGroupDto) {
  return repo.createGroup(orgId, dto)
}

export async function updateGroup(orgId: string, groupId: string, dto: UpdateGroupDto) {
  await getGroup(orgId, groupId)
  return repo.updateGroup(orgId, groupId, dto)
}

// ── Vehicles ────────────────────────────────────────────────────────────────

export async function listVehicles(orgId: string, query: ListQuery) {
  return repo.findAllVehicles(orgId, query)
}

export async function getVehicle(orgId: string, vehicleId: string) {
  const v = await repo.findVehicleById(orgId, vehicleId)
  if (!v) throw new NotFoundError('Vehicle')
  return v
}

export async function createVehicle(orgId: string, dto: CreateVehicleDto) {
  return repo.createVehicle(orgId, dto)
}

export async function updateVehicle(orgId: string, vehicleId: string, dto: UpdateVehicleDto) {
  await getVehicle(orgId, vehicleId)
  return repo.updateVehicle(orgId, vehicleId, dto)
}

export async function deleteVehicle(orgId: string, vehicleId: string) {
  await getVehicle(orgId, vehicleId)
  return repo.deleteVehicle(orgId, vehicleId)
}

// ── Assignments ─────────────────────────────────────────────────────────────

export async function listAssignments(orgId: string, vehicleId: string, activeOnly: boolean) {
  await getVehicle(orgId, vehicleId)
  return repo.findAssignments(vehicleId, activeOnly)
}

export async function createAssignment(orgId: string, vehicleId: string, dto: CreateAssignmentDto, assignedById?: string) {
  await getVehicle(orgId, vehicleId)

  // Prevent duplicate active PRIMARY assignment
  if (dto.assignmentType === 'PRIMARY') {
    const active = await repo.findAssignments(vehicleId, true)
    const hasActivePrimary = active.some((a) => a.assignmentType === 'PRIMARY')
    if (hasActivePrimary) throw new ConflictError('Vehicle already has an active PRIMARY assignment. End it first.')
  }

  return repo.createAssignment(vehicleId, dto, assignedById)
}

export async function endAssignment(orgId: string, vehicleId: string, assignmentId: string) {
  await getVehicle(orgId, vehicleId)
  return repo.endAssignment(assignmentId)
}
