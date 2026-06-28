import { prisma } from '../../lib/prisma.js'
import type { CreateFillingDto, ListFillingQuery, CreateTheftDto, ListTheftQuery } from './fuel.schema.js'

function buildDateFilter(from?: Date, to?: Date) {
  if (!from && !to) return undefined
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
}

// ── Fillings ─────────────────────────────────────────────────────────────────

export async function findAllFillings(orgId: string, q: ListFillingQuery) {
  const dateFilter = buildDateFilter(q.from, q.to)
  const where = {
    vehicle: { organisationId: orgId },
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.reportingPeriodId ? { reportingPeriodId: q.reportingPeriodId } : {}),
    ...(dateFilter ? { filledAt: dateFilter } : {}),
  }
  const items = await prisma.fuelFilling.findMany({
    where,
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    orderBy: { filledAt: 'desc' },
    include: { vehicle: { select: { id: true, name: true, registrationPlate: true } } },
  })
  const hasNextPage = items.length > q.limit
  if (hasNextPage) items.pop()
  return { data: items, cursor: items.at(-1)?.id ?? null, hasNextPage }
}

export async function findFillingById(orgId: string, id: string) {
  return prisma.fuelFilling.findFirst({
    where: { id, vehicle: { organisationId: orgId } },
    include: { vehicle: { select: { id: true, name: true } }, reportingPeriod: { select: { id: true, label: true } } },
  })
}

export async function createFilling(dto: CreateFillingDto) {
  return prisma.fuelFilling.create({ data: dto })
}

// ── Thefts ───────────────────────────────────────────────────────────────────

export async function findAllThefts(orgId: string, q: ListTheftQuery) {
  const dateFilter = buildDateFilter(q.from, q.to)
  const where = {
    vehicle: { organisationId: orgId },
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.reportingPeriodId ? { reportingPeriodId: q.reportingPeriodId } : {}),
    ...(dateFilter ? { beganAt: dateFilter } : {}),
  }
  const items = await prisma.fuelTheft.findMany({
    where,
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    orderBy: { beganAt: 'desc' },
    include: {
      vehicle: { select: { id: true, name: true, registrationPlate: true } },
      driver: { select: { id: true, fullName: true } },
    },
  })
  const hasNextPage = items.length > q.limit
  if (hasNextPage) items.pop()
  return { data: items, cursor: items.at(-1)?.id ?? null, hasNextPage }
}

export async function findTheftById(orgId: string, id: string) {
  return prisma.fuelTheft.findFirst({
    where: { id, vehicle: { organisationId: orgId } },
    include: {
      vehicle: { select: { id: true, name: true } },
      driver: { select: { id: true, fullName: true } },
      reportingPeriod: { select: { id: true, label: true } },
    },
  })
}

export async function createTheft(dto: CreateTheftDto) {
  return prisma.fuelTheft.create({ data: dto })
}
