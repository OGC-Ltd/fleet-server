import { prisma } from '../../lib/prisma.js'
import type { CreatePeriodDto, CreateEngineSessionDto, ListPeriodQuery, ListEngineSessionQuery, ListSummaryQuery } from './report.schema.js'

// ── Reporting Periods ─────────────────────────────────────────────────────────

export async function findAllPeriods(orgId: string, q: ListPeriodQuery) {
  const skip = (q.page - 1) * q.limit
  const where = { organisationId: orgId, ...(q.periodType ? { periodType: q.periodType } : {}) }
  const [data, total] = await prisma.$transaction([
    prisma.reportingPeriod.findMany({ where, skip, take: q.limit, orderBy: { periodStart: 'desc' } }),
    prisma.reportingPeriod.count({ where }),
  ])
  return { data, total }
}

export async function findPeriodById(orgId: string, periodId: string) {
  return prisma.reportingPeriod.findFirst({ where: { id: periodId, organisationId: orgId } })
}

export async function createPeriod(orgId: string, dto: CreatePeriodDto) {
  return prisma.reportingPeriod.create({ data: { ...dto, organisationId: orgId } })
}

// ── Engine Hour Sessions ──────────────────────────────────────────────────────

export async function findAllEngineSessions(orgId: string, q: ListEngineSessionQuery) {
  const where = {
    vehicle: { organisationId: orgId },
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.reportingPeriodId ? { reportingPeriodId: q.reportingPeriodId } : {}),
    ...((q.from ?? q.to)
      ? { beganAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
  }
  const items = await prisma.engineHourSession.findMany({
    where,
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    orderBy: { beganAt: 'desc' },
    include: { vehicle: { select: { id: true, name: true, registrationPlate: true } } },
  })
  const hasNextPage = items.length > q.limit
  if (hasNextPage) items.pop()
  return { data: items, cursor: items.at(-1)?.id ?? null, hasNextPage }
}

export async function createEngineSession(dto: CreateEngineSessionDto) {
  return prisma.engineHourSession.create({ data: dto })
}

// ── Vehicle Period Summaries ──────────────────────────────────────────────────

export async function findSummaries(orgId: string, q: ListSummaryQuery) {
  const skip = (q.page - 1) * q.limit
  const where = {
    vehicle: { organisationId: orgId },
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.reportingPeriodId ? { reportingPeriodId: q.reportingPeriodId } : {}),
  }
  const [data, total] = await prisma.$transaction([
    prisma.vehiclePeriodSummary.findMany({
      where,
      skip,
      take: q.limit,
      orderBy: { refreshedAt: 'desc' },
      include: {
        vehicle: { select: { id: true, name: true, registrationPlate: true } },
        reportingPeriod: { select: { id: true, label: true } },
      },
    }),
    prisma.vehiclePeriodSummary.count({ where }),
  ])
  return { data, total }
}

/**
 * Upserts a summary record. Called by the async refresh job (not a user action).
 * Using upsert ensures idempotent refreshes when re-aggregating.
 */
export async function upsertSummary(vehicleId: string, reportingPeriodId: string, metrics: Record<string, unknown>) {
  return prisma.vehiclePeriodSummary.upsert({
    where: { vehicleId_reportingPeriodId: { vehicleId, reportingPeriodId } },
    update: { ...metrics, refreshedAt: new Date() },
    create: { vehicleId, reportingPeriodId, ...metrics, refreshedAt: new Date() },
  })
}
