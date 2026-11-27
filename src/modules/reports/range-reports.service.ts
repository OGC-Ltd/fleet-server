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
import { readDayKm, keepDayKm, SETTLE_MS } from './day-km.cache.js'
import { prisma } from '../../lib/prisma.js'
import { reportDb } from '../../lib/report-db.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { balanceFrom, edgeLevelL, EDGE_READING_COUNT, reportableConsumptionL } from '../fuel/fuel-balance.js'
import { getAlarms } from '../dashcam/dashcam.service.js'
import { toIncident, type LoggedIncident } from './driver-conduct.service.js'
import { targetFor, unitTarget, type FuelTarget } from './fuel-target-rates.js'

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

export type DistanceSource = 'odometer' | 'gps'
export interface DayDistance { km: number; source: DistanceSource }

/** The day's evidence for one unit, as dayKm's query returns it. */
export interface DayKmEvidence {
  gpsKm: number
  /** The odometer's own count: the plausible steps between the day's readings, km. */
  odoKm: number
  odoReadings: number
  fixes: number
}

/**
 * Which figure a unit's day is (operator, 18 Nov 2026: "store it, then use it").
 * The tracker's odometer (io_16) where the unit sends one on at least half its
 * fixes, as usage-review.compute judges it; the GPS sum otherwise, and on days
 * before the odometer was stored. A counter that stood still while the GPS
 * covered real ground is stuck, not parked: under half the GPS figure on a day
 * of more than 5 km, the GPS figure stands.
 */
export function pickDayKm(e: DayKmEvidence): DayDistance {
  const usable = e.odoReadings >= 2 && e.fixes > 0 && e.odoReadings / e.fixes >= 0.5
  const stuck = e.gpsKm > 5 && e.odoKm < e.gpsKm * 0.5
  return usable && !stuck ? { km: e.odoKm, source: 'odometer' } : { km: e.gpsKm, source: 'gps' }
}

/** Over a range: the one source every day used, or "mixed". */
export const rangeSource = (sources: Set<DistanceSource>): DistanceSource | 'mixed' | null =>
  sources.size === 0 ? null : sources.size === 1 ? [...sources][0]! : 'mixed'

/** The fastest a step between two odometer readings may imply; past it the step is a glitch. */
export const ODO_MAX_KMH = 200

/**
 * Kilometres per unit over one fleet day: the tracker's odometer where it sends
 * one (pickDayKm), else "mileage in trips" as fuel-balance.tripDistanceKm counts
 * it, in SQL so a month of a large fleet is not carried over the wire:
 * consecutive fixes while moving (3 km/h and over), no more than 20 minutes
 * apart, steps under 20 m left out as jitter. It does not drop the short blips
 * that function does, so it can read a little higher. The odometer counts each
 * rise between consecutive readings, never a fall (a reset) nor a rise faster
 * than ODO_MAX_KMH (a glitch).
 */
export async function dayKmEvidence(vehicleIds: string[], from: Date, to: Date): Promise<Map<string, DayKmEvidence>> {
  if (!vehicleIds.length) return new Map()
  const rows = await reportDb().$queryRaw<Array<{ vehicle_id: string; gps_km: number | null; odo_km: number | null; odo_n: number | bigint | null; fixes: number | bigint | null }>>`
    WITH p AS (
      -- The row's own reading first, else one filled in from Wialon (unit-distance).
      SELECT t.vehicle_id, t.captured_at, t.lat, t.lng, t.speed_kmh, COALESCE(t.odometer_m, f.odometer_m) AS odometer_m,
             LAG(t.lat) OVER w AS plat, LAG(t.lng) OVER w AS plng, LAG(t.captured_at) OVER w AS pt
        FROM vehicle_telemetries t
        LEFT JOIN (
          SELECT vehicle_id, captured_at, odometer_m FROM vehicle_odometer_fills
           WHERE vehicle_id = ANY(${vehicleIds}) AND captured_at >= ${from} AND captured_at < ${to}
        ) f ON f.vehicle_id = t.vehicle_id AND f.captured_at = t.captured_at
       WHERE t.vehicle_id = ANY(${vehicleIds}) AND t.captured_at >= ${from} AND t.captured_at < ${to}
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL AND NOT (t.lat = 0 AND t.lng = 0)
      WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.captured_at)
    ), s AS (
      SELECT vehicle_id, speed_kmh, captured_at - pt AS gap,
             2 * 6371008.8 * asin(sqrt(power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2))) AS m
        FROM p WHERE pt IS NOT NULL
    ), g AS (
      SELECT vehicle_id, SUM(m) / 1000 AS km
        FROM s WHERE speed_kmh >= 3 AND gap <= interval '20 minutes' AND m >= 20
       GROUP BY vehicle_id
    ), o AS (
      SELECT vehicle_id, odometer_m - LAG(odometer_m) OVER wo AS dm,
             EXTRACT(EPOCH FROM captured_at - LAG(captured_at) OVER wo) AS ds
        FROM p WHERE odometer_m IS NOT NULL
      WINDOW wo AS (PARTITION BY vehicle_id ORDER BY captured_at)
    ), ok AS (
      SELECT vehicle_id,
             SUM(CASE WHEN dm > 0 AND ds > 0 AND dm / ds * 3.6 <= ${ODO_MAX_KMH} THEN dm ELSE 0 END) / 1000 AS km
        FROM o GROUP BY vehicle_id
    ), n AS (
      SELECT vehicle_id, COUNT(*) AS fixes, COUNT(odometer_m) AS odo_n FROM p GROUP BY vehicle_id
    )
    SELECT n.vehicle_id, g.km AS gps_km, ok.km AS odo_km, n.odo_n, n.fixes
      FROM n LEFT JOIN g USING (vehicle_id) LEFT JOIN ok USING (vehicle_id)`
  return new Map(rows.map((r) => [r.vehicle_id, {
    gpsKm: Number(r.gps_km ?? 0), odoKm: Number(r.odo_km ?? 0),
    odoReadings: Number(r.odo_n ?? 0), fixes: Number(r.fixes ?? 0),
  }]))
}

/**
 * The day's evidence for these units, from the 7-day cache (day-km.cache) where it has the
 * unit-day and from the database for the rest, which are then kept. A day not yet settled
 * is read from the database every time. Units with no fixes that day are left out, as
 * dayKmEvidence leaves them out; they are cached as such, so they are not asked again.
 */
export async function cachedDayKmEvidence(vehicleIds: string[], day: string, now = Date.now()): Promise<Map<string, DayKmEvidence>> {
  const { from, to } = fleetDayBounds(day)!
  if (!vehicleIds.length) return new Map()
  if (to.getTime() > now - SETTLE_MS) return dayKmEvidence(vehicleIds, from, to)
  const out = await readDayKm(vehicleIds, day, now)
  const miss = vehicleIds.filter((id) => !out.has(id))
  if (miss.length) {
    const got = await dayKmEvidence(miss, from, to)
    const none: DayKmEvidence = { gpsKm: 0, odoKm: 0, odoReadings: 0, fixes: 0 }
    await keepDayKm(miss.map((id) => [id, got.get(id) ?? none]), day, now)
    for (const id of miss) out.set(id, got.get(id) ?? none)
  }
  for (const [id, e] of out) if (e.fixes === 0 && e.odoReadings === 0) out.delete(id)
  return out
}

async function rangeKm(vehicleIds: string[], days: string[], now: number) {
  const total = new Map<string, number>()
  const sources = new Map<string, Set<DistanceSource>>()
  for (const day of days) {
    const ev = await cachedDayKmEvidence(vehicleIds, day, now)
    const km = new Map([...ev].map(([id, e]) => [id, pickDayKm(e)]))
    for (const [id, d] of km) {
      total.set(id, (total.get(id) ?? 0) + d.km)
      sources.set(id, (sources.get(id) ?? new Set()).add(d.source))
    }
  }
  return { total, sources }
}

/** Probe fault episodes the report heeds: the tracker's own fault code, and the probe gone silent. */
// fuel_probe_status: the tracker's own status codes (2026-11-27). Not the probe battery: a low battery still reads.
export const PROBE_FAULT_KINDS = ['fuel_probe_fault', 'fuel_probe_dead', 'fuel_probe_status']

/**
 * Each unit's probe fault during [from, to), in words ("Lost Contact with Tubes Error - Needs
 * Replacement"), from sensor_fault_episodes: an episode that began before `to` and had not recovered
 * by `from`. The latest-begun one where there are several. Units without one are absent.
 */
export async function probeFaultsIn(vehicleIds: string[], from: Date, to: Date): Promise<Map<string, string>> {
  if (!vehicleIds.length) return new Map()
  const eps = await prisma.sensorFaultEpisode.findMany({
    where: {
      vehicleId: { in: vehicleIds }, kind: { in: PROBE_FAULT_KINDS }, startedAt: { lt: to },
      OR: [{ recoveredAt: null }, { recoveredAt: { gte: from } }],
    },
    select: { vehicleId: true, detail: true, startedAt: true },
    orderBy: { startedAt: 'asc' },
  })
  const out = new Map<string, string>()
  for (const e of eps) out.set(e.vehicleId, probeFaultText(e.detail))
  return out
}

/** "Fuel probe: Lost Contact …" → "Lost Contact …"; an empty detail reads as a plain fault. Pure. */
export const probeFaultText = (detail: string | null | undefined) =>
  String(detail ?? '').replace(/^\s*fuel probe:\s*/i, '').trim() || 'fuel probe fault'

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
  /** Where the distance came from: the tracker's odometer, the GPS sum, or both over a range. Null with no fixes. */
  distanceSource: DistanceSource | 'mixed' | null
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
    select: { id: true, registrationPlate: true, name: true, model: true, tankCapacityLitres: true, standardKmPerL: true },
    orderBy: { registrationPlate: 'asc' },
  })
  const ids = vehicles.map((v) => v.id)
  const [{ total: km, sources }, edges, fillings, drains, faults] = await Promise.all([
    rangeKm(ids, days, now),
    edgeLevels(ids, from, to),
    reportDb().fuelFilling.findMany({
      where: { vehicleId: { in: ids }, filledAt: { gte: from, lt: to } },
      select: { vehicleId: true, filledAt: true, verdict: true, observedRiseMl: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
    }),
    reportDb().fuelTheft.findMany({
      where: { vehicleId: { in: ids }, beganAt: { gte: from, lt: to } },
      select: { vehicleId: true, beganAt: true, verdict: true, drainCause: true, cleanDropMl: true, measuredDropMl: true, stolenMl: true, finalFuelLevelMl: true, reviewStatus: true, dismissedAt: true },
    }),
    probeFaultsIn(ids, from, to),
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
    // The unit's own standard first (operator, 2026-11-25: Menengai's per-unit standard consumption), else the old sheet
    const target = unitTarget(v.standardKmPerL) ?? targetFor(v.registrationPlate, v.model ?? v.name)
    // A probe the tracker (or the dead-probe sweep) recorded as faulty during the range: its fuel
    // figures cannot be believed, whatever they come to (operator, 2026-11-25)
    const fault = faults.get(v.id)
    const note = fault ? `PROBE ISSUE: ${fault}`
      : bal.startL == null
      ? (v.tankCapacityLitres == null ? 'No fuel probe' : 'No fuel readings')
      : consumedL == null ? 'Tank rose without a recorded refill'
      : distanceKm < 1 ? 'Did not move' : ''
    return {
      vehicleId: v.id, plate: v.registrationPlate, model: v.model,
      distanceKm, distanceSource: rangeSource(sources.get(v.id) ?? new Set()), startL: bal.startL, filledL: bal.filledL, theftL: bal.theftL, endL: bal.endL,
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
