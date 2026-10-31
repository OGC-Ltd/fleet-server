/**
 * The driver scorecard for an organisation over a range of fleet days.
 *
 * Every event is put on the driver who held the vehicle at that moment
 * (vehicles/driver-assignment), then each driver's day is scored by
 * driver-score.rules. A driver gets a day — and with it the speed-compliance
 * points — on any day a vehicle they held moved at road speed.
 *
 * Sources:
 *   · speeding_incidents             overspeed (§3.2) and speeding > 15 (violations)
 *   · provider_alerts HARSH_BRAKING  harsh braking, force stored in g (see rules)
 *   · VSS dashcam alarms              seat belt, phone, free-wheeling — read live,
 *                                     and only for the last DASHCAM_DAYS days
 *
 *   · dispatches (COMPLETED, or returned)  trips: trip-wise pay by route, lunch
 *   · fuel_daily_trends + vehicle_daily_stats  km/L and average moving speed (§3.1)
 *
 * The pay is the whole package of the pay-structure workbook (driver-score.rules):
 * retainer pro-rated to the period, trip-wise pay, lunch, fuel, speed and safety
 * incentives, and the zero-tolerance deductions. Zero-tolerance standing is a
 * MONTHLY count, so violations are read from the first of the month even when
 * the period starts later; only the period's own days are paid.
 *
 * Events on a vehicle nobody held are counted, not scored, so the gap in the
 * driver mapping stays visible.
 */
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { getAlarms } from '../dashcam/dashcam.service.js'
import { assignmentAt } from '../vehicles/driver-assignment.js'
import { factoryOf } from '../webhooks/factory-map.js'
import {
  PAY_RULES, scoreDay, monthStanding, harshForceMs2, routeOf, retainerForDay, suspensionDayKes, netOf,
  type DayInput, type DayScore, type ViolationKind, type TripInput, type FuelInput,
} from './driver-score.rules.js'

/** Longest range one request may score. */
export const MAX_RANGE_DAYS = 31
/** VSS answers alarms for the last 7 days only (dashcam.service MAX_DAYS). */
const DASHCAM_DAYS = 7
/** A VSS search can queue behind another; past this the scorecard goes without. */
const DASHCAM_WAIT_MS = 25_000
/** Road speed: TODAY counts as driven once the vehicle went faster than this (past days: see drivenDays). */
const DRIVEN_KMH = 20

const DASHCAM_KIND = new Map<number, Exclude<ViolationKind, 'speeding' | 'harshBrake'>>([
  [125, 'seatbelt'], [51, 'seatbelt'],   // driver camera, tracker seat-belt alarm
  [116, 'phone'], [264, 'phone'],        // phone call, texting on phone
  [38, 'freewheel'],                     // needs a CAN-bus link to the camera
])

const dayOf = (d: Date): string => fleetDayKey(d).toISOString().slice(0, 10)

export interface DriverDay extends DayScore { day: string; plates: string[] }

export interface DriverPay {
  /** Retainer for the period's calendar days. */
  retainer:   number
  tripPay:    number
  /** Trip-wise pay earned but lost to zero tolerance. */
  tripPayLost: number
  lunch:      number
  fuelKes:    number
  speedKes:   number
  safetyKes:  number
  /** 1-day suspensions without pay, as a negative figure. */
  suspension: number
  gross:      number
  /** Estimated, at 85% of gross. */
  net:        number
}

export interface DriverScore {
  driverId:     string
  name:         string
  days:         number
  trips:        number
  unpricedTrips: number
  speedPoints:  number
  speedKes:     number
  fuelPoints:   number
  fuelKes:      number
  /** Average km/L over the days with a usable probe reading; null without one. */
  kmpl:         number | null
  fuelDays:     number
  safetyPoints: number
  safetyKes:    number
  /** Incentives and penalties: speed + fuel + safety. */
  totalKes:     number
  pay:          DriverPay
  violations:   Record<ViolationKind, number>
  tripPayDaysLost: number
  /** Zero-tolerance standing per calendar month in the range, counted from the 1st. */
  months:       Array<{ month: string; violations: number; standing: 'ok' | 'suspension' | 'termination'; suspendedHere: boolean }>
  byDay:        DriverDay[]
}

export interface ScorecardAnswer {
  from: string
  to:   string
  rules: typeof PAY_RULES
  drivers: DriverScore[]
  coverage: {
    vehiclesDriven:     number
    vehiclesWithDriver: number
    /** Events on a vehicle nobody held at the time — counted, not scored. */
    unattributed: Record<'overspeed' | 'harshBrake' | 'dashcam' | 'trips', number>
    dashcam: { checked: boolean; complete: boolean; from: string | null; untyped: number; note: string | null }
  }
  manual: string[]
  /** Organisation name, for the PDF. */
  organisation: string
}

/** Moving fixes (engine on, not idle) that make a past fleet day a driven one. */
const MIN_MOVING_FIXES = 20

/**
 * The vehicles driven on each fleet day, and a moment on that day to ask
 * "who held it" at.
 *
 * Past days come from `vehicle_daily_stats` — one row per vehicle per day,
 * moving fixes = engine fixes − idle fixes — and the moment is midday. Days
 * with an event are credited from the event's own time as well, so a
 * handover is still seen where it matters. Today is not in that table, so
 * today alone is read from the telemetry: when the vehicle first and last
 * went faster than DRIVEN_KMH.
 *
 * Why not the telemetry for every day: a month of an organisation's frames in
 * one aggregate ran past the pool's read timeout ("This month", 1–30 Oct,
 * failed for MENENGAI and SUKARI on 2026-10-30), per-day queries took 2.5–3
 * minutes for the month, and index probes per vehicle-day 37 s (MENENGAI) to
 * 108 s (SUKARI). The rollup answers the month in about 25 ms.
 */
async function drivenDays(orgId: string, start: Date, end: Date) {
  const todayStart = fleetDayStart(new Date())
  const pastEnd = new Date(Math.min(end.getTime(), todayStart.getTime()))
  const out: Array<{ vehicle_id: string; first_at: Date; last_at: Date }> = []

  if (start < pastEnd) {
    const rows = await prisma.$queryRaw<Array<{ vehicle_id: string; day: Date }>>`
      SELECT s.vehicle_id, s.day
        FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id
       WHERE v.organisation_id = ${orgId}
         AND s.day >= ${fleetDayKey(start)} AND s.day < ${fleetDayKey(pastEnd)}
         AND coalesce(s.engine_fixes, 0) - coalesce(s.idle_fixes, 0) >= ${MIN_MOVING_FIXES}`
    for (const r of rows) {
      // `day` is the fleet day's date at UTC midnight; EAT noon is 09:00 UTC.
      const noon = new Date(r.day.getTime() + 9 * 3_600_000)
      out.push({ vehicle_id: r.vehicle_id, first_at: noon, last_at: noon })
    }
  }

  if (end > todayStart) {
    const from = new Date(Math.max(start.getTime(), todayStart.getTime()))
    out.push(...await prisma.$queryRaw<Array<{ vehicle_id: string; first_at: Date; last_at: Date }>>`
      SELECT t.vehicle_id, min(t.captured_at) AS first_at, max(t.captured_at) AS last_at
        FROM vehicle_telemetries t JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND t.captured_at >= ${from} AND t.captured_at < ${end}
         AND t.speed_kmh > ${DRIVEN_KMH}
       GROUP BY t.vehicle_id`)
  }
  return out
}

/** Kabras route: the lower average-speed qualifier for the fuel bonus (§3.1, B10). */
const KABRAS_ORG = 'KABRAS'
/** A trip counts once it is completed or back. */
const COMPLETED = new Set(['COMPLETED'])

export async function getDriverScorecard(orgId: string, fromDay: string, toDay: string): Promise<ScorecardAnswer> {
  const start = fleetDayStart(new Date(`${fromDay}T12:00:00+03:00`))
  const end   = new Date(fleetDayStart(new Date(`${toDay}T12:00:00+03:00`)).getTime() + 86_400_000)
  // Zero tolerance counts the month: read from its 1st, pay only the period.
  const countStart = fleetDayStart(new Date(`${fromDay.slice(0, 8)}01T12:00:00+03:00`))

  const [org, vehicles, assignments, driven, speeding, harsh, dispatches, trends, stats] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true, code: true } }),
    prisma.vehicle.findMany({ where: { organisationId: orgId }, select: { id: true, registrationPlate: true } }),
    prisma.vehicleAssignment.findMany({
      where:  { vehicle: { organisationId: orgId }, assignedAt: { lt: end },
                OR: [{ unassignedAt: null }, { unassignedAt: { gt: countStart } }] },
      select: { vehicleId: true, userId: true, assignedAt: true, unassignedAt: true, notes: true,
                user: { select: { fullName: true } } },
    }),
    drivenDays(orgId, countStart, end),
    prisma.speedingIncident.findMany({
      where:  { organisationId: orgId, startedAt: { gte: countStart, lt: end } },
      select: { vehicleId: true, startedAt: true, overByKmh: true },
    }),
    prisma.providerAlert.findMany({
      where:  { organisationId: orgId, type: 'HARSH_BRAKING', createdAt: { gte: countStart, lt: end } },
      select: { vehicleId: true, createdAt: true, raw: true },
    }),
    prisma.dispatch.findMany({
      where:  { organisationId: orgId, dispatchedAt: { gte: start, lt: end },
                OR: [{ status: { in: [...COMPLETED] } }, { actualReturnAt: { not: null } }] },
      select: { vehicleId: true, dispatchedAt: true, factoryCode: true, destination: true, externalId: true, serialNumber: true },
    }),
    prisma.fuelDailyTrend.findMany({
      where:  { vehicle: { organisationId: orgId }, day: { gte: fleetDayKey(start), lt: fleetDayKey(end) } },
      select: { vehicleId: true, day: true, distanceM: true, engineBurnMl: true, engineSeconds: true },
    }),
    prisma.vehicleDailyStat.findMany({
      where:  { vehicle: { organisationId: orgId }, day: { gte: fleetDayKey(start), lt: fleetDayKey(end) } },
      select: { vehicleId: true, day: true, engineFixes: true, idleFixes: true },
    }),
  ])
  const kabras = org?.code === KABRAS_ORG

  const plate = new Map(vehicles.map(v => [v.id, v.registrationPlate]))
  const byVehicle = new Map<string, typeof assignments>()
  for (const a of assignments) {
    const list = byVehicle.get(a.vehicleId) ?? []
    list.push(a)
    byVehicle.set(a.vehicleId, list)
  }
  const holder = (vehicleId: string | null, at: Date) =>
    vehicleId ? assignmentAt(byVehicle.get(vehicleId) ?? [], at) : null

  // driverId → day → input, plus the days each driver drove.
  type Slot = DayInput & { plates: Set<string>; trips: TripInput[]; fuelParts: Array<{ km: number; l: number; hours: number | null }> }
  const names = new Map<string, string>()
  const inputs = new Map<string, Map<string, Slot>>()
  const slot = (driverId: string, name: string, day: string) => {
    names.set(driverId, name)
    let days = inputs.get(driverId)
    if (!days) inputs.set(driverId, days = new Map())
    let d = days.get(day)
    if (!d) days.set(day, d = { overspeeds: [], violations: [], trips: [], fuelParts: [], plates: new Set() })
    return d
  }

  const drivenVehicles = new Set<string>(), withDriver = new Set<string>()
  for (const r of driven) {
    drivenVehicles.add(r.vehicle_id)
    // The holder when it first moved and when it last moved: a handover mid-day
    // gives both drivers the day.
    for (const at of [r.first_at, r.last_at]) {
      const a = holder(r.vehicle_id, at)
      if (!a) continue
      withDriver.add(r.vehicle_id)
      slot(a.userId, a.user.fullName, dayOf(at)).plates.add(plate.get(r.vehicle_id) ?? '?')
    }
  }

  const unattributed = { overspeed: 0, harshBrake: 0, dashcam: 0, trips: 0 }

  for (const s of speeding) {
    const a = holder(s.vehicleId, s.startedAt)
    if (!a) { unattributed.overspeed++; continue }
    slot(a.userId, a.user.fullName, dayOf(s.startedAt)).overspeeds.push({
      at: s.startedAt.toISOString(), vehicleId: s.vehicleId, plate: plate.get(s.vehicleId) ?? null, overKmh: s.overByKmh,
    })
  }

  const harshLimit = PAY_RULES.safety.violations.harshBrake.overMs2
  for (const h of harsh) {
    const raw = (h.raw ?? {}) as { ms2?: number | null; at?: string }
    const force = typeof raw.ms2 === 'number' ? harshForceMs2(raw.ms2) : null
    if (force == null || force <= harshLimit) continue
    const at = raw.at ? new Date(raw.at) : h.createdAt
    const a = holder(h.vehicleId, at)
    if (!a) { unattributed.harshBrake++; continue }
    slot(a.userId, a.user.fullName, dayOf(at)).violations.push({
      at: at.toISOString(), vehicleId: h.vehicleId!, plate: plate.get(h.vehicleId!) ?? null,
      kind: 'harshBrake', value: Math.round(force * 10) / 10,
    })
  }

  // Trips: each completed dispatch, on the driver who held the unit when it left.
  for (const d of dispatches) {
    const a = holder(d.vehicleId, d.dispatchedAt)
    if (!a || !d.vehicleId) { unattributed.trips++; continue }
    const gate = d.factoryCode ? factoryOf(d.factoryCode) : null
    const s = slot(a.userId, a.user.fullName, dayOf(d.dispatchedAt))
    s.plates.add(plate.get(d.vehicleId) ?? '?')
    s.trips.push({
      at: d.dispatchedAt.toISOString(), vehicleId: d.vehicleId, plate: plate.get(d.vehicleId) ?? null,
      route: routeOf([gate?.label, d.factoryCode, d.destination, org?.code]),
      ref: d.serialNumber ?? d.externalId,
    })
  }

  // Fuel: each vehicle-day's distance and cleaned burn, on whoever held it at
  // midday; the moving share of engine time gives the average speed.
  const statOf = new Map(stats.map(r => [`${r.vehicleId}|${r.day.toISOString().slice(0, 10)}`, r]))
  for (const t of trends) {
    if (t.distanceM == null || t.engineBurnMl == null || t.engineBurnMl <= 0) continue
    const day = t.day.toISOString().slice(0, 10)
    const noon = new Date(t.day.getTime() + 9 * 3_600_000)
    const a = holder(t.vehicleId, noon)
    if (!a) continue
    const st = statOf.get(`${t.vehicleId}|${day}`)
    const movingShare = st?.engineFixes ? 1 - (st.idleFixes ?? 0) / st.engineFixes : null
    const hours = t.engineSeconds != null && movingShare != null ? (t.engineSeconds / 3600) * movingShare : null
    slot(a.userId, a.user.fullName, day).fuelParts.push({ km: t.distanceM / 1000, l: t.engineBurnMl / 1000, hours })
  }
  // Dashcam: VSS keeps a week, so only the part of the range inside it.
  const dashcam: ScorecardAnswer['coverage']['dashcam'] = { checked: false, complete: true, from: null, untyped: 0, note: null }
  const camFrom = new Date(Math.max(start.getTime(), Date.now() - DASHCAM_DAYS * 86_400_000))
  if (camFrom < end) {
    dashcam.checked = true
    dashcam.from = camFrom.toISOString()
    if (camFrom > start) dashcam.note = `Dashcam alarms are available for the last ${DASHCAM_DAYS} days only, so no dashcam violations are shown before ${dayOf(camFrom)}.`
    try {
      const answer = await Promise.race([
        getAlarms(orgId, null, camFrom.toISOString()),
        new Promise<null>(resolve => setTimeout(() => resolve(null), DASHCAM_WAIT_MS)),
      ])
      if (!answer) { dashcam.complete = false; dashcam.note = 'The camera server did not respond in time, so dashcam violations are not included.' }
      else {
        dashcam.complete = !answer.partial && !answer.stale
        for (const inc of answer.incidents) {
          if (inc.code === 0) { dashcam.untyped++; continue }
          const kind = DASHCAM_KIND.get(inc.code)
          if (!kind || !inc.occurredAt || !inc.vehicleId) continue
          const at = new Date(inc.occurredAt)
          if (at < start || at >= end) continue
          const a = holder(inc.vehicleId, at)
          if (!a) { unattributed.dashcam++; continue }
          slot(a.userId, a.user.fullName, dayOf(at)).violations.push({
            at: at.toISOString(), vehicleId: inc.vehicleId, plate: inc.plate ?? plate.get(inc.vehicleId) ?? null, kind, value: null,
          })
        }
        if (dashcam.untyped > 0) {
          dashcam.complete = false
          dashcam.note = `${dashcam.untyped.toLocaleString('en-KE')} dashcam alarm${dashcam.untyped === 1 ? ' has' : 's have'} not yet been classified by the camera server, so the dashcam totals are incomplete. Refresh the page later for a more complete count.`
        }
      }
    } catch (err) {
      logger.warn({ err, orgId }, 'driver scorecard: dashcam alarms failed')
      dashcam.complete = false
      dashcam.note = 'The camera server could not be reached, so dashcam violations are not included.'
    }
  }

  const fuelOf = (parts: Slot['fuelParts']): FuelInput | null => {
    if (!parts.length) return null
    const km = parts.reduce((n, p) => n + p.km, 0)
    const l = parts.reduce((n, p) => n + p.l, 0)
    const timed = parts.every(p => p.hours != null && p.hours > 0)
    const hours = timed ? parts.reduce((n, p) => n + p.hours!, 0) : 0
    return { distanceKm: km, burnL: l, avgKmh: timed && hours > 0 ? Math.round((km / hours) * 10) / 10 : null }
  }

  const periodDays: string[] = []
  for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) periodDays.push(dayOf(new Date(t + 12 * 3_600_000)))
  const retainer = Math.round(periodDays.reduce((n, d) => n + retainerForDay(d), 0))

  const drivers: DriverScore[] = []
  for (const [driverId, days] of inputs) {
    const all: DriverDay[] = [...days].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, input]) => ({ day, plates: [...input.plates], ...scoreDay({ ...input, fuel: fuelOf(input.fuelParts) }, PAY_RULES, { kabras }) }))
    // Month-to-date counts the zero-tolerance standing; only the period is paid.
    const byDay = all.filter(d => d.day >= fromDay && d.day <= toDay)
    if (!byDay.length) continue

    const violations = Object.fromEntries(Object.keys(PAY_RULES.safety.violations).map(k => [k, 0])) as Record<ViolationKind, number>
    for (const d of byDay) for (const e of d.events) if (e.rule === 'safety') violations[e.kind as ViolationKind]++

    // Per month: the count up to the end of the period, and before it began, so
    // a suspension is charged in the period that crossed the line, once.
    const months = [...new Set(byDay.map(d => d.day.slice(0, 7)))].map(month => {
      const inMonth = all.filter(d => d.day.startsWith(month))
      const total = inMonth.reduce((n, d) => n + d.violations, 0)
      const before = inMonth.filter(d => d.day < fromDay).reduce((n, d) => n + d.violations, 0)
      const line = PAY_RULES.zeroTolerance.suspendMonth
      return { month, violations: total, standing: monthStanding(total), suspendedHere: before < line && total >= line }
    })

    const sum = (f: (d: DriverDay) => number) => byDay.reduce((n, d) => n + f(d), 0)
    const speedPoints  = sum(d => d.speedPoints)
    const fuelPoints   = sum(d => d.fuel.points)
    const safetyPoints = sum(d => d.safetyPoints)
    const speedKes  = speedPoints * PAY_RULES.speed.kesPerPoint
    const fuelKes   = fuelPoints * PAY_RULES.fuel.kesPerPoint
    const safetyKes = safetyPoints * PAY_RULES.safety.kesPerPoint
    const fuelDays = byDay.filter(d => d.fuel.kmpl != null && d.fuel.why !== 'implausible')
    const tripPay = sum(d => d.tripPay)
    const lunch = sum(d => d.lunch)
    const suspension = -months.filter(m => m.suspendedHere).length * suspensionDayKes()
    const gross = Math.round(retainer + tripPay + lunch + fuelKes + speedKes + safetyKes + suspension)
    drivers.push({
      driverId, name: names.get(driverId) ?? '?', days: byDay.filter(d => d.plates.length || d.trips).length,
      trips: sum(d => d.trips), unpricedTrips: sum(d => d.unpricedTrips),
      speedPoints, speedKes, fuelPoints, fuelKes,
      kmpl: fuelDays.length ? Math.round((fuelDays.reduce((n, d) => n + d.fuel.kmpl!, 0) / fuelDays.length) * 100) / 100 : null,
      fuelDays: fuelDays.length,
      safetyPoints, safetyKes, totalKes: speedKes + fuelKes + safetyKes,
      pay: { retainer, tripPay, tripPayLost: sum(d => d.tripPayEarned - d.tripPay), lunch, fuelKes, speedKes, safetyKes,
             suspension, gross, net: netOf(gross) },
      violations,
      tripPayDaysLost: byDay.filter(d => d.losesTripPay).length,
      months,
      byDay,
    })
  }
  drivers.sort((a, b) => a.totalKes - b.totalKes || a.name.localeCompare(b.name))

  return {
    from: fromDay, to: toDay, rules: PAY_RULES, drivers, organisation: org?.name ?? '',
    coverage: { vehiclesDriven: drivenVehicles.size, vehiclesWithDriver: withDriver.size, unattributed, dashcam },
    manual: [
      // Clauses, not sentences: the page joins them into one ("The following
      // are not scored here: a; b; and c.").
      'vehicle care (§3.3) and its perfect-score and driver-of-the-quarter bonuses, which require the inspection app’s score',
      'the retainer growth path, which depends on tenure and the vehicle-care average',
      'unexcused absenteeism, which requires attendance records',
      'running a red light or driving without headlights, which neither the trackers nor the cameras can detect',
    ],
  }
}
