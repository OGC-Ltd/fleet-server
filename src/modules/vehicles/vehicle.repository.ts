import { prisma } from '../../lib/prisma.js'
import type { CreateGroupDto, UpdateGroupDto, CreateVehicleDto, UpdateVehicleDto, CreateAssignmentDto, ListQuery } from './vehicle.schema.js'

// ── Vehicle Groups ──────────────────────────────────────────────────────────

export async function findAllGroups(orgId: string, page: number, limit: number) {
  const skip = (page - 1) * limit
  const where = { organisationId: orgId }
  const [data, total] = await prisma.$transaction([
    prisma.vehicleGroup.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
    prisma.vehicleGroup.count({ where }),
  ])
  return { data, total }
}

export async function findGroupById(orgId: string, groupId: string) {
  return prisma.vehicleGroup.findFirst({ where: { id: groupId, organisationId: orgId } })
}

export async function createGroup(orgId: string, dto: CreateGroupDto) {
  return prisma.vehicleGroup.create({ data: { ...dto, organisationId: orgId } })
}

export async function updateGroup(orgId: string, groupId: string, dto: UpdateGroupDto) {
  return prisma.vehicleGroup.update({ where: { id: groupId, organisationId: orgId }, data: dto })
}

// ── Vehicles ────────────────────────────────────────────────────────────────

const WITH_GROUP = { vehicleGroup: { select: { id: true, name: true, code: true } } }

export async function findAllVehicles(orgId: string, { page, limit, vehicleGroupId }: ListQuery) {
  const skip = (page - 1) * limit
  const where = { organisationId: orgId, ...(vehicleGroupId ? { vehicleGroupId } : {}) }
  const [data, total] = await prisma.$transaction([
    prisma.vehicle.findMany({ where, skip, take: limit, include: WITH_GROUP, orderBy: { name: 'asc' } }),
    prisma.vehicle.count({ where }),
  ])
  return { data, total }
}

export async function findVehicleById(orgId: string, vehicleId: string) {
  return prisma.vehicle.findFirst({ where: { id: vehicleId, organisationId: orgId }, include: WITH_GROUP })
}

export async function createVehicle(orgId: string, dto: CreateVehicleDto) {
  return prisma.vehicle.create({ data: { ...dto, organisationId: orgId }, include: WITH_GROUP })
}

export async function updateVehicle(orgId: string, vehicleId: string, dto: UpdateVehicleDto) {
  return prisma.vehicle.update({ where: { id: vehicleId, organisationId: orgId }, data: dto, include: WITH_GROUP })
}

export async function deleteVehicle(orgId: string, vehicleId: string) {
  return prisma.vehicle.delete({ where: { id: vehicleId, organisationId: orgId } })
}

// ── Assignments ─────────────────────────────────────────────────────────────

const WITH_ASSIGNMENT = {
  user: { select: { id: true, fullName: true, email: true } },
  assignedBy: { select: { id: true, fullName: true } },
}

export async function findAssignments(vehicleId: string, activeOnly: boolean) {
  return prisma.vehicleAssignment.findMany({
    where: { vehicleId, ...(activeOnly ? { unassignedAt: null } : {}) },
    include: WITH_ASSIGNMENT,
    orderBy: { assignedAt: 'desc' },
  })
}

export async function createAssignment(vehicleId: string, dto: CreateAssignmentDto, assignedById?: string) {
  return prisma.vehicleAssignment.create({
    data: { vehicleId, userId: dto.userId, assignmentType: dto.assignmentType, notes: dto.notes, assignedById },
    include: WITH_ASSIGNMENT,
  })
}

export async function endAssignment(assignmentId: string) {
  return prisma.vehicleAssignment.update({
    where: { id: assignmentId },
    data: { unassignedAt: new Date() },
    include: WITH_ASSIGNMENT,
  })
}
