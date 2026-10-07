/**
 * Reads the rows the fuel performance review needs and hands them to the pure
 * method in fuel-performance-review.ts.
 *
 * Telemetry only for now: "fuel put in" is the fillings ledger's confirmed
 * REFILLs, and work is the daily trend's engine-hours meter (engine time where
 * it has none) or distance. Issuance (SIV) records replace the litres once they
 * are imported. Cached per org and period for five minutes: the page and its
 * PDF export ask for the same review back to back.
 */

import { prisma } from '../../lib/prisma.js'
import { BadRequestError } from '../../core/errors/errors.js'
import {
  buildPerformanceReview, reviewUnit,
  type PerformanceReview, type ReviewDay, type ReviewFill, type ReviewVehicle, type ReviewUnit, type RateBasis,
} from './fuel-performance-review.js'

const DAY_MS = 86_400_000
const EAT_MS = 3 * 3_600_000
const MAX_DAYS = 366
const TTL_MS = 5 * 60_000
const KEY = /^\d{4}-\d{2}-\d{2}$/

const cache = new Map<string, { at: number; value: PerformanceReview }>()

const startOf = (key: string) => new Date(Date.parse(`${key}T00:00:00.000Z`) - EAT_MS)

/** Default: the 90 fleet days ending yesterday, as the document's quarter. */
export function reviewPeriod(from?: unknown, to?: unknown, now = new Date()): { from: string; to: string } {
  const today = new Date(now.getTime() + EAT_MS).toISOString().slice(0, 10)
  const back = (key: string, n: number) => new Date(startOf(key).getTime() + EAT_MS - n * DAY_MS).toISOString().slice(0, 10)
  const t = typeof to === 'string' && KEY.test(to) ? to : back(today, 1)
  const f = typeof from === 'string' && KEY.test(from) ? from : back(t, 89)
  if (f > t) throw new BadRequestError('`from` is after `to`')
  if ((startOf(t).getTime() - startOf(f).getTime()) / DAY_MS + 1 > MAX_DAYS) {
    throw new BadRequestError(`A review covers at most ${MAX_DAYS} days`)
  }
  return { from: f, to: t }
}

async function load(orgId: string, from: string, to: string, vehicleId?: string) {
  const start = startOf(from)
  const end = new Date(startOf(to).getTime() + DAY_MS)
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true, ...(vehicleId ? { id: vehicleId } : {}) },
    select: { id: true, name: true, equipmentCategory: true, ratedConsumption: true, ratedConsumptionBasis: true },
  })
  const ids = vehicles.map(v => v.id)
  const [fillRows, dayRows] = await Promise.all([
    prisma.fuelFilling.findMany({
      where: { vehicleId: { in: ids }, verdict: 'REFILL', filledAt: { gte: start, lt: end } },
      select: { vehicleId: true, filledAt: true, filledMl: true },
    }),
    prisma.fuelDailyTrend.findMany({
      // The day before `from` too: a meter step needs the previous reading.
      where: { vehicleId: { in: ids }, day: { gte: new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS), lte: new Date(`${to}T00:00:00Z`) } },
      select: { vehicleId: true, day: true, engineHoursMeter: true, engineSeconds: true, distanceM: true },
    }),
  ])
  const fills = new Map<string, ReviewFill[]>()
  for (const r of fillRows) {
    if (r.filledMl <= 0) continue
    const list = fills.get(r.vehicleId) ?? []
    list.push({ at: r.filledAt, litres: r.filledMl / 1000 })
    fills.set(r.vehicleId, list)
  }
  const days = new Map<string, ReviewDay[]>()
  for (const r of dayRows) {
    const list = days.get(r.vehicleId) ?? []
    list.push({
      day: r.day.toISOString().slice(0, 10),
      meter: r.engineHoursMeter,
      engineSeconds: r.engineSeconds,
      distanceKm: r.distanceM != null ? r.distanceM / 1000 : null,
    })
    days.set(r.vehicleId, list)
  }
  const reviewVehicles: ReviewVehicle[] = vehicles.map(v => ({
    id: v.id, name: v.name, category: v.equipmentCategory,
    rate: v.ratedConsumption, basis: (v.ratedConsumptionBasis as RateBasis | null) ?? null,
  }))
  return { vehicles: reviewVehicles, fills, days }
}

export async function getPerformanceReview(orgId: string, from: string, to: string): Promise<PerformanceReview> {
  const key = `${orgId}|${from}|${to}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = buildPerformanceReview({ from, to, ...(await load(orgId, from, to)) })
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  return value
}

/** One unit with every refill row — the drill-down behind a bar. */
export async function getUnitPerformance(orgId: string, vehicleId: string, from: string, to: string): Promise<ReviewUnit | null> {
  const { vehicles, fills, days } = await load(orgId, from, to, vehicleId)
  const v = vehicles[0]
  if (!v) return null
  return reviewUnit(v, fills.get(v.id) ?? [], days.get(v.id) ?? [], { withRefills: true })
}
