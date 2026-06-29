import { prisma } from '../../lib/prisma.js'
import type { CreateGeofence, UpdateGeofence, GeofenceListQuery } from './geofence.schema.js'

export async function create(orgId: string, createdById: string, dto: CreateGeofence) {
  return prisma.geofence.create({
    data: {
      organisationId: orgId,
      name:           dto.name,
      type:           dto.type,
      mode:           dto.mode ?? 'ALLOWLIST',
      centerLat:      dto.type === 'CIRCLE'  ? dto.centerLat  : undefined,
      centerLng:      dto.type === 'CIRCLE'  ? dto.centerLng  : undefined,
      radiusM:        dto.type === 'CIRCLE'  ? dto.radiusM    : undefined,
      polygonCoords:  dto.type === 'POLYGON' ? dto.polygonCoords : undefined,
    },
  })
}

export async function findAll(orgId: string, q: GeofenceListQuery) {
  const rows = await prisma.geofence.findMany({
    where: {
      organisationId: orgId,
      ...(q.isActive !== undefined ? { isActive: q.isActive } : {}),
      ...(q.cursor ? { id: { gt: q.cursor } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: q.limit + 1,
  })
  const hasNextPage = rows.length > q.limit
  if (hasNextPage) rows.pop()
  return { data: rows, cursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null, hasNextPage }
}

export async function findById(id: string, orgId: string) {
  return prisma.geofence.findFirst({ where: { id, organisationId: orgId } })
}

export async function update(id: string, orgId: string, dto: UpdateGeofence) {
  const fence = await prisma.geofence.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.geofence.update({ where: { id }, data: dto })
}

export async function remove(id: string, orgId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.geofence.delete({ where: { id } })
}

export async function assignVehicle(geofenceId: string, orgId: string, vehicleId: string, assignedById: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.vehicleGeofence.upsert({
    where:  { vehicleId_geofenceId: { vehicleId, geofenceId } },
    create: { vehicleId, geofenceId, assignedById },
    update: {},
  })
}

export async function unassignVehicle(geofenceId: string, orgId: string, vehicleId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.vehicleGeofence.deleteMany({ where: { vehicleId, geofenceId } })
}

export async function listVehicles(geofenceId: string, orgId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.vehicleGeofence.findMany({
    where: { geofenceId },
    include: { vehicle: { select: { id: true, plateNumber: true } } },
  })
}

export async function listViolations(geofenceId: string, orgId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.geofenceViolation.findMany({
    where:   { geofenceId },
    orderBy: { occurredAt: 'desc' },
    take:    100,
  })
}
