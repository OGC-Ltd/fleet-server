import { NotFoundError } from '../../core/errors/errors.js'
import * as repo from './report.repository.js'
import { prisma } from '../../lib/prisma.js'
import type { CreatePeriodDto, CreateEngineSessionDto, ListPeriodQuery, ListEngineSessionQuery, ListSummaryQuery } from './report.schema.js'

// ── Reporting Periods ─────────────────────────────────────────────────────────

export const listPeriods = (orgId: string, q: ListPeriodQuery) => repo.findAllPeriods(orgId, q)

export async function getPeriod(orgId: string, periodId: string) {
  const period = await repo.findPeriodById(orgId, periodId)
  if (!period) throw new NotFoundError('Reporting period')
  return period
}

export const createPeriod = (orgId: string, dto: CreatePeriodDto) => repo.createPeriod(orgId, dto)

// ── Engine Sessions ────────────────────────────────────────────────────────────

export const listEngineSessions = (orgId: string, q: ListEngineSessionQuery) => repo.findAllEngineSessions(orgId, q)

export const createEngineSession = (dto: CreateEngineSessionDto) => repo.createEngineSession(dto)

// ── Summaries ─────────────────────────────────────────────────────────────────

export const listSummaries = (orgId: string, q: ListSummaryQuery) => repo.findSummaries(orgId, q)

/**
 * Triggers an aggregate refresh for all vehicles in a period.
 * Runs the aggregation in application code and upserts each summary.
 *
 * SCALABILITY NOTE: For large orgs, push this to a background queue (BullMQ/Inngest)
 * rather than blocking the HTTP response.
 */
export async function refreshSummaries(orgId: string, periodId: string) {
  const period = await repo.findPeriodById(orgId, periodId)
  if (!period) throw new NotFoundError('Reporting period')

  // Aggregate trips per vehicle for this period
  const vehicleAggregates = await prisma.trip.groupBy({
    by: ['vehicleId'],
    where: { reportingPeriodId: periodId, vehicle: { organisationId: orgId } },
    _sum: { mileageKm: true, engineHoursSeconds: true, consumedByFlsMl: true },
    _avg: { avgSpeedKmh: true, avgConsumptionByFls: true, avgMileagePerUnitFls: true },
    _max: { maxSpeedKmh: true, finalFuelLevelMl: true },
    _min: { initialFuelLevelMl: true },
  })

  const fuelTotals = await prisma.fuelFilling.groupBy({
    by: ['vehicleId'],
    where: { reportingPeriodId: periodId, vehicle: { organisationId: orgId } },
    _sum: { filledMl: true },
  })

  const theftTotals = await prisma.fuelTheft.groupBy({
    by: ['vehicleId'],
    where: { reportingPeriodId: periodId, vehicle: { organisationId: orgId } },
    _sum: { stolenMl: true },
  })

  const fuelMap = new Map(fuelTotals.map((f) => [f.vehicleId, f._sum.filledMl]))
  const theftMap = new Map(theftTotals.map((t) => [t.vehicleId, t._sum.stolenMl]))

  const upserts = vehicleAggregates.map((agg) =>
    repo.upsertSummary(agg.vehicleId, periodId, {
      mileageInTripsKm: agg._sum.mileageKm,
      avgSpeedKmh: agg._avg.avgSpeedKmh,
      maxSpeedKmh: agg._max.maxSpeedKmh,
      engineHoursSeconds: agg._sum.engineHoursSeconds,
      consumedByFlsMl: agg._sum.consumedByFlsMl,
      avgConsumptionByFls: agg._avg.avgConsumptionByFls,
      avgMileagePerUnitFls: agg._avg.avgMileagePerUnitFls,
      initialFuelLevelMl: agg._min.initialFuelLevelMl,
      finalFuelLevelMl: agg._max.finalFuelLevelMl,
      totalFilledMl: fuelMap.get(agg.vehicleId) ?? null,
      totalStolenMl: theftMap.get(agg.vehicleId) ?? null,
    }),
  )

  await Promise.all(upserts)
  return { refreshed: upserts.length }
}
