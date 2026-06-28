import { prisma } from '../../lib/prisma.js'
import type { CreateTripDto, ListTripQuery } from './trip.schema.js'

export async function findAll(orgId: string, q: ListTripQuery) {
  const where = {
    vehicle: { organisationId: orgId },
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.driverId ? { driverId: q.driverId } : {}),
    ...(q.reportingPeriodId ? { reportingPeriodId: q.reportingPeriodId } : {}),
    ...((q.from ?? q.to)
      ? { beganAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
  }

  const trips = await prisma.trip.findMany({
    where,
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    orderBy: { beganAt: 'desc' },
    include: {
      vehicle: { select: { id: true, name: true, registrationPlate: true } },
      driver: { select: { id: true, fullName: true } },
    },
  })

  const hasNextPage = trips.length > q.limit
  if (hasNextPage) trips.pop()
  const nextCursor = hasNextPage ? trips.at(-1)?.id ?? null : null

  return { data: trips, cursor: nextCursor, hasNextPage }
}

export async function findById(orgId: string, tripId: string) {
  return prisma.trip.findFirst({
    where: { id: tripId, vehicle: { organisationId: orgId } },
    include: {
      vehicle: { select: { id: true, name: true, registrationPlate: true } },
      driver: { select: { id: true, fullName: true } },
      reportingPeriod: { select: { id: true, label: true } },
    },
  })
}

export async function create(dto: CreateTripDto) {
  return prisma.trip.create({ data: dto })
}
