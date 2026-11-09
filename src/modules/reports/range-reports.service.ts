/**
 * Three Movements reports worked out here rather than in the browser (v47
 * review, 10 Nov 2026: "ensure that the reports are generated from the
 * server"). The page sends a range of fleet days and draws what comes back.
 *
 *   Fuel Consumption Rate   per unit over the range: the fuel balance of
 *                           fuel-balance.ts (start and end tank, the ledger's
 *                           refills and thefts) and the distance driven, against
 *                           the operator's target km/L (fuel-target-rates.ts).
 *                           The page used to stitch TAT trip rows together as
 *                           if they were days, which lost the fuel and the km
 *                           between trips.
 *   AI Alarm Distribution   dashcam alarms per unit by kind, from the VSS search
 *                           the alarm rail uses, saying when VSS gave only part.
 *   Unauthorized Passengers the incidents operators logged with that violation,
 *                           with when each was shared.
 */
import { prisma } from '../../lib/prisma.js'
import { reportDb } from '../../lib/report-db.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { balanceFrom, edgeLevelL, EDGE_READING_COUNT, reportableConsumptionL } from '../fuel/fuel-balance.js'
import { getAlarms } from '../dashcam/dashcam.service.js'
import { toIncident, type LoggedIncident } from './driver-conduct.service.js'
import { targetFor, type FuelTarget } from './fuel-target-rates.js'

const DAY_MS = 86_400_000

/** [from, to) of a range of fleet days, both days included. */
export function rangeBounds(fromDay: string, toDay: string, maxDays: number): { from: Date; to: Date; days: string[] } {
  const a = fleetDayBounds(fromDay), b = fleetDayBounds(toDay)
  if (!a || !b) throw new BadRequestError('A fleet day is YYYY-MM-DD')
  const days: string[] = []
  for (let t = a.from.getTime(); t <= b.from.getTime(); t += DAY_MS) days.push(new Date(t + 3 * 3_600_000).toISOString().slice(0, 10))
  if (!days.length) throw new BadRequestError('From must not be after to')
  if (days.length > maxDays) throw new BadRequestError(`At most ${maxDays} days`)
  return { from: a.from, to: b.to, days }
}

// ── Fuel Consumption Rate ──────────────────────────────────────────────────

export const FUEL_RATE_MAX_DAYS = 31

/**
 * Kilometres per unit over one fleet day, "mileage in trips" as
 * fuel-balance.tripDistanceKm counts it, in SQL so a month of a large fleet is
 * not carried over the wire: consecutive fixes while moving (3 km/h and over),
 * no more than 20 minutes apart, steps under 20 m left out as jitter. It does
 * not drop the short blips that function does, so it can read a little higher.
 */
async function dayKm(vehicleIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
  if (!vehicleIds.length) return new Map()
  const rows = await reportDb().$queryRaw<Array<{ vehicle_id: string; km: number | null }>>`
    WITH p AS (
      SELECT t.vehicle_id, t.captured_at, t.lat, t.lng, t.speed_kmh,
             LAG(t.lat) OVER w AS plat, LAG(t.lng) OVER w AS plng, LAG(t.captured_at) OVER w AS pt
        FROM vehicle_telemetries t
       WHERE t.vehicle_id = ANY(${vehicleIds}) AND t.captured_at >= ${from} AND t.captured_at < ${to}
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL AND NOT (t.lat = 0 AND t.lng = 0)
      WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.captured_at)
    ), s AS (
      SELECT vehicle_id, speed_kmh, captured_at - pt AS gap,
             2 * 6371008.8 * asin(sqrt(power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2))) AS m
        FROM p WHERE pt IS NOT NULL
    )
    SELECT vehicle_id, SUM(m) / 1000 AS km
      FROM s WHERE speed_kmh >= 3 AND gap <= interval '20 minutes' AND m >= 20
     GROUP BY vehicle_id`
  return new Map(rows.map((r) => [r.vehicle_id, Number(r.km ?? 0)]))
}

/** A finished day does not change: kept, per organisation and day, for the next run. */
const kmCache = new Map<string, Map<string, number>>()
const KM_CACHE_MAX = 2_000

async function rangeKm(orgId: string, vehicleIds: string[], days: string[], now: number): Promise<Map<string, number>> {
  const total = new Map<string, number>()
  for (const day of days) {
    const { from, to: end } = fleetDayBounds(day)!
    const key = `${orgId}|${day}|${vehicleIds.length}`
    let km = kmCache.get(key)
    if (!km) {
      km = await dayKm(vehicleIds, from, end)
      // Only a day well over: the latest readings arrive late.
      if (end.getTime() < now - 6 * 3_600_000) {
        if (kmCache.size >= KM_CACHE_MAX) kmCache.delete(kmCache.keys().next().value!)
        kmCache.set(key, km)
      }
    }
    for (const [id, k] of km) total.set(id, (total.get(id) ?? 0) + k)
  }
  return total
}

/** The tank at the start and end of the range: the middle of the first and last 7 readings. */
async function edgeLevels(vehicleIds: string[], from: Date, to: Date) {
  if (!vehicleIds.length) return new Map<string, { first: number[]; last: number[] }>()
  const rows = await reportDb().$queryRaw<Array<{ id: string; first: number[] | null; last: number[] | null }>>`
    SELECT v.id,
      (SELECT array_agg(fuel_level_ml) FROM (SELECT fuel_level_ml FROM vehicle_telemetries t
         WHERE t.vehicle_id = v.id AND t.captured_at >= ${from} AND t.captured_at < ${to} AND t.fuel_level_ml >= 1000
         ORDER BY t.captured_at ASC LIMIT ${EDGE_READING_COUNT}) a) AS first,
      (SELECT array_agg(fuel_level_ml) FROM (SELECT fuel_level_ml FROM vehicle_telemetries t
         WHERE t.vehicle_id = v.id AND t.captured_at >= ${from} AND t.captured_at < ${to} AND t.fuel_level_ml >= 1000
         ORDER BY t.captured_at DESC LIMIT ${EDGE_READING_COUNT}) b) AS last
    FROM vehicles v WHERE v.id = ANY(${vehicleIds})`
  return new Map(rows.map((r) => [r.id, { first: r.first ?? [], last: r.last ?? [] }]))
}

export interface FuelRateRow {
  vehicleId: string; plate: string; model: string | null
  distanceKm: number
  startL: number | null; filledL: number; theftL: number; endL: number | null
  /** Null where it cannot be worked out, or cannot be believed (reportableConsumptionL). */
  consumedL: number | null
  kmPerL: number | null
  target: FuelTarget | null
  /** Below target, when both are known. */
  belowTarget: boolean | null
  /** Why a figure is missing, in the operator's words. */
  note: string
}

export async function fuelConsumptionRate(orgId: string, scope: Set<string> | null, fromDay: string, toDay: string, now = Date.now()) {
  const { from, to, days } = rangeBounds(fromDay, toDay, FUEL_RATE_MAX_DAYS)
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true, ...(scope ? { id: { in: [...scope] } } : {}) },
    select: { id: true, registrationPlate: true, name: true, model: true, tankCapacityLitres: true },
    orderBy: { registrationPlate: 'asc' },
  })
  const ids = vehicles.map((v) => v.id)
  const [km, edges, fillings, drains] = await Promise.all([
    rangeKm(orgId, ids, days, now),
    edgeLevels(ids, from, to),
    reportDb().fuelFilling.findMany({
      where: { vehicleId: { in: ids }, filledAt: { gte: from, lt: to } },
      select: { vehicleId: true, filledAt: true, verdict: true, observedRiseMl: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
    }),
    reportDb().fuelTheft.findMany({
      where: { vehicleId: { in: ids }, beganAt: { gte: from, lt: to } },
      select: { vehicleId: true, beganAt: true, verdict: true, drainCause: true, cleanDropMl: true, measuredDropMl: true, stolenMl: true, finalFuelLevelMl: true, reviewStatus: true, dismissedAt: true },
    }),
  ])
  const group = <T extends { vehicleId: string }>(xs: T[]) => {
    const m = new Map<string, T[]>()
    for (const x of xs) m.set(x.vehicleId, [...(m.get(x.vehicleId) ?? []), x])
    return m
  }
  const fillsOf = group(fillings), drainsOf = group(drains)

  const rows: FuelRateRow[] = vehicles.map((v) => {
    const e = edges.get(v.id)
    const distanceKm = Math.round((km.get(v.id) ?? 0) * 10) / 10
    const bal = balanceFrom({
      startL: edgeLevelL(e?.first ?? []), endL: edgeLevelL([...(e?.last ?? [])].reverse()), distanceKm,
      fillings: (fillsOf.get(v.id) ?? []).map((f) => ({ ...f, at: f.filledAt.getTime() })),
      drains: (drainsOf.get(v.id) ?? []).map((d) => ({ ...d, at: d.beganAt.getTime() })),
      from: from.getTime(), to: to.getTime(),
    })
    const consumedL = reportableConsumptionL(bal, distanceKm)
    const kmPerL = consumedL != null && consumedL > 0 && distanceKm >= 1 ? Math.round((distanceKm / consumedL) * 100) / 100 : null
    const target = targetFor(v.registrationPlate, v.model ?? v.name)
    const note = bal.startL == null
      ? (v.tankCapacityLitres == null ? 'No fuel probe' : 'No fuel readings')
      : consumedL == null ? 'Tank rose without a recorded refill'
      : distanceKm < 1 ? 'Did not move' : ''
    return {
      vehicleId: v.id, plate: v.registrationPlate, model: v.model,
      distanceKm, startL: bal.startL, filledL: bal.filledL, theftL: bal.theftL, endL: bal.endL,
      consumedL, kmPerL, target,
      belowTarget: kmPerL != null && target ? kmPerL < target.kmPerL : null,
      note,
    }
  })
  const measured = rows.filter((r) => r.consumedL != null && r.consumedL > 0 && r.distanceKm >= 1)
  const totalKm = Math.round(measured.reduce((n, r) => n + r.distanceKm, 0) * 10) / 10
  const totalL = Math.round(measured.reduce((n, r) => n + r.consumedL!, 0) * 10) / 10
  return {
    from: fromDay, to: toDay, days: days.length, rows,
    totals: { units: rows.length, measured: measured.length, distanceKm: totalKm, consumedL: totalL, kmPerL: totalL > 0 ? Math.round((totalKm / totalL) * 100) / 100 : null },
  }
}

// ── AI Alarm Distribution ──────────────────────────────────────────────────

/** VSS keeps a week of alarms. */
export const ALARM_MAX_DAYS = 7

export const ALARM_KINDS = [
  { key: 'fatigue', label: 'Fatigue driving', match: /fatigue/i },
  { key: 'phone', label: 'Phone call', match: /phone/i },
  { key: 'smoking', label: 'Smoking', match: /smok/i },
  { key: 'covered', label: 'Camera covered', match: /cover/i },
  { key: 'distracted', label: 'Distracted driving', match: /distract/i },
  { key: 'seatbelt', label: 'No seat belt', match: /seat.?belt|no.?seat/i },
] as const
export type AlarmKind = (typeof ALARM_KINDS)[number]['key'] | 'other'
export const alarmKind = (label: string): AlarmKind => ALARM_KINDS.find((k) => k.match.test(label))?.key ?? 'other'

export type AlarmRow = { plate: string; vehicleId: string; total: number } & Record<AlarmKind, number>

export async function alarmDistribution(orgId: string, scope: Set<string> | null, fromDay: string, toDay: string, now = Date.now()) {
  const { from, to } = rangeBounds(fromDay, toDay, ALARM_MAX_DAYS)
  if (from.getTime() < now - ALARM_MAX_DAYS * DAY_MS - DAY_MS) throw new BadRequestError(`The dashcams keep ${ALARM_MAX_DAYS} days of alarms`)
  const answer = await getAlarms(orgId, scope, from.toISOString())
  const byUnit = new Map<string, AlarmRow>()
  for (const a of answer.incidents) {
    const t = a.occurredAt ? Date.parse(a.occurredAt) : NaN
    if (!Number.isFinite(t) || t < from.getTime() || t >= to.getTime()) continue
    const key = a.vehicleId || a.plate
    let row = byUnit.get(key)
    if (!row) {
      row = { plate: a.plate || 'Unknown', vehicleId: a.vehicleId, total: 0, fatigue: 0, phone: 0, smoking: 0, covered: 0, distracted: 0, seatbelt: 0, other: 0 }
      byUnit.set(key, row)
    }
    row[alarmKind(a.label)]++
    row.total++
  }
  const rows = [...byUnit.values()].sort((a, b) => b.total - a.total || a.plate.localeCompare(b.plate))
  return {
    from: fromDay, to: toDay, cameras: answer.cameras, rows,
    kinds: [...ALARM_KINDS.map(({ key, label }) => ({ key, label })), { key: 'other', label: 'Other' }],
    // VSS refused later pages, or the answer is an older saved one: the counts are short.
    partial: Boolean(answer.partial), stale: Boolean(answer.stale),
  }
}

// ── Unauthorized Passengers ────────────────────────────────────────────────

export const PASSENGERS_VIOLATION = 'Unauthorized Passengers'
export const PASSENGERS_MAX_DAYS = 92

export async function unauthorizedPassengers(orgId: string, scope: Set<string> | null, fromDay: string, toDay: string) {
  const { from, to } = rangeBounds(fromDay, toDay, PASSENGERS_MAX_DAYS)
  const rows = await prisma.operatorIncident.findMany({
    where: {
      organisationId: orgId, kind: 'other', other: { equals: PASSENGERS_VIOLATION, mode: 'insensitive' },
      at: { gte: from, lt: to },
      ...(scope ? { vehicleId: { in: [...scope] } } : {}),
    },
    orderBy: { at: 'desc' },
  })
  const incidents: LoggedIncident[] = rows.map(toIncident)
  return {
    from: fromDay, to: toDay, incidents,
    totals: { incidents: incidents.length, units: new Set(incidents.map((i) => i.vehicleId ?? i.plate)).size, shared: incidents.filter((i) => i.sharedAt != null).length },
  }
}
