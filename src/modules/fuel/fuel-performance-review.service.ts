/**
 * Reads the rows the fuel performance review needs and hands them to the pure
 * method in fuel-performance-review.ts.
 *
 * Fuel put in is FactorySuite's pump issues where they are kept
 * (factorysuite_fuel_issues: litres issued, the meter at this fuelling and the
 * last, the tank's rise on the probe), matched to a unit by its equipment
 * reference. Before the organisation's first pump issue, and for a unit the
 * pumps never fuelled, it is the fillings ledger's confirmed REFILLs, as
 * before (operator 2026-11-28: "for the days we don't have value the previous
 * days we use the fuel probes"). Work is the issue's meter step, else the
 * daily trend's engine-hours meter (engine time where it has none) or
 * distance. Cached per org and period for five minutes: the page and its PDF
 * export ask for the same review back to back.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { foldName } from '../planner/work-plan-match.js'
import type { RaiFactorySuiteFuelIssueRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'
import { BadRequestError } from '../../core/errors/errors.js'
import {
  buildPerformanceReview, reviewUnit, pumpFill,
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

/**
 * The organisation's pump issues in the period, as refills, with the first
 * day it has any pump issue at all and every machine the pumps have fuelled.
 */
async function pumpIssues(orgId: string, from: string, to: string) {
  const empty = { from: null as string | null, machines: new Set<string>(), issues: [] as Array<{ machine: string; fill: ReviewFill }> }
  try {
    const [first, machines, rows] = await Promise.all([
      prisma.factorySuiteFuelIssue.findFirst({
        where: { organisationId: orgId, goneAt: null }, orderBy: { day: 'asc' }, select: { day: true },
      }),
      prisma.factorySuiteFuelIssue.findMany({
        where: { organisationId: orgId, goneAt: null }, distinct: ['machine'], select: { machine: true },
      }),
      prisma.factorySuiteFuelIssue.findMany({
        where: { organisationId: orgId, goneAt: null, day: { gte: from, lte: to } },
        select: { machine: true, day: true, row: true },
      }),
    ])
    const issues: Array<{ machine: string; fill: ReviewFill }> = []
    for (const r of rows) {
      const fill = pumpFill(r.row as unknown as RaiFactorySuiteFuelIssueRow, r.day)
      if (fill) issues.push({ machine: r.machine, fill })
    }
    return { from: first?.day ?? null, machines: new Set(machines.map(m => foldName(m.machine))), issues }
  } catch (err) {
    logger.warn({ err, orgId }, 'Kept fuel issues unavailable for the performance review; probe refills only')
    return empty
  }
}

async function load(orgId: string, from: string, to: string, vehicleId?: string) {
  const start = startOf(from)
  const end = new Date(startOf(to).getTime() + DAY_MS)
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true, ...(vehicleId ? { id: vehicleId } : {}) },
    select: { id: true, name: true, equipmentCategory: true, ratedConsumption: true, ratedConsumptionBasis: true, equipmentReference: true },
  })
  const ids = vehicles.map(v => v.id)
  const [fillRows, dayRows, pump] = await Promise.all([
    prisma.fuelFilling.findMany({
      where: { vehicleId: { in: ids }, verdict: 'REFILL', filledAt: { gte: start, lt: end } },
      select: { vehicleId: true, filledAt: true, filledMl: true },
    }),
    prisma.fuelDailyTrend.findMany({
      // The day before `from` too: a meter step needs the previous reading.
      where: { vehicleId: { in: ids }, day: { gte: new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS), lte: new Date(`${to}T00:00:00Z`) } },
      select: { vehicleId: true, day: true, engineHoursMeter: true, engineSeconds: true, distanceM: true },
    }),
    pumpIssues(orgId, from, to),
  ])
  const fills = new Map<string, ReviewFill[]>()
  const add = (id: string, f: ReviewFill) => fills.set(id, [...(fills.get(id) ?? []), f])

  const byRef = new Map<string, string>()
  const refOf = new Map(vehicles.map(v => [v.id, v.equipmentReference]))
  for (const v of vehicles) if (v.equipmentReference) byRef.set(foldName(v.equipmentReference), v.id)
  for (const i of pump.issues) {
    const id = byRef.get(foldName(i.machine))
    if (id) add(id, i.fill)
  }
  // Probe refills count where the pumps have no record: before the first pump
  // issue, and for units the pumps have never fuelled.
  const pumpFromMs = pump.from ? startOf(pump.from).getTime() : Infinity
  for (const r of fillRows) {
    if (r.filledMl <= 0) continue
    const ref = refOf.get(r.vehicleId)
    const pumped = ref != null && pump.machines.has(foldName(ref))
    if (pumped && r.filledAt.getTime() >= pumpFromMs) continue
    add(r.vehicleId, { at: r.filledAt, litres: r.filledMl / 1000, source: 'probe' })
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
