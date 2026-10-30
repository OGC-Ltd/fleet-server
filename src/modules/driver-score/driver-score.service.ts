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
 * Events on a vehicle nobody held are counted, not scored, so the gap in the
 * driver mapping stays visible.
 */
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { getAlarms } from '../dashcam/dashcam.service.js'
import { assignmentAt } from '../vehicles/driver-assignment.js'
import {
  SCORE_RULES, scoreDay, monthStanding, harshForceMs2,
  type DayInput, type DayScore, type ViolationKind,
} from './driver-score.rules.js'

/** Longest range one request may score. */
export const MAX_RANGE_DAYS = 31
/** VSS answers alarms for the last 7 days only (dashcam.service MAX_DAYS). */
const DASHCAM_DAYS = 7
/** A VSS search can queue behind another; past this the scorecard goes without. */
const DASHCAM_WAIT_MS = 25_000
/** Road speed: a day on which the vehicle went faster than this counts as driven. */
const DRIVEN_KMH = 20

const DASHCAM_KIND = new Map<number, Exclude<ViolationKind, 'speeding' | 'harshBrake'>>([
  [125, 'seatbelt'], [51, 'seatbelt'],   // driver camera, tracker seat-belt alarm
  [116, 'phone'], [264, 'phone'],        // phone call, texting on phone
  [38, 'freewheel'],                     // needs a CAN-bus link to the camera
])

const dayOf = (d: Date): string => fleetDayKey(d).toISOString().slice(0, 10)

export interface DriverDay extends DayScore { day: string; plates: string[] }

export interface DriverScore {
  driverId:     string
  name:         string
  days:         number
  speedPoints:  number
  speedKes:     number
  safetyPoints: number
  safetyKes:    number
  totalKes:     number
  violations:   Record<ViolationKind, number>
  tripPayDaysLost: number
  /** Zero-tolerance standing per calendar month in the range. */
  months:       Array<{ month: string; violations: number; standing: 'ok' | 'suspension' | 'termination' }>
  byDay:        DriverDay[]
}

export interface ScorecardAnswer {
  from: string
  to:   string
  rules: typeof SCORE_RULES
  drivers: DriverScore[]
  coverage: {
    vehiclesDriven:     number
    vehiclesWithDriver: number
    /** Events on a vehicle nobody held at the time — counted, not scored. */
    unattributed: Record<'overspeed' | 'harshBrake' | 'dashcam', number>
    dashcam: { checked: boolean; complete: boolean; from: string | null; untyped: number; note: string | null }
  }
  manual: string[]
}

export async function getDriverScorecard(orgId: string, fromDay: string, toDay: string): Promise<ScorecardAnswer> {
  const start = fleetDayStart(new Date(`${fromDay}T12:00:00+03:00`))
  const end   = new Date(fleetDayStart(new Date(`${toDay}T12:00:00+03:00`)).getTime() + 86_400_000)

  const [vehicles, assignments, driven, speeding, harsh] = await Promise.all([
    prisma.vehicle.findMany({ where: { organisationId: orgId }, select: { id: true, registrationPlate: true } }),
    prisma.vehicleAssignment.findMany({
      where:  { vehicle: { organisationId: orgId }, assignedAt: { lt: end },
                OR: [{ unassignedAt: null }, { unassignedAt: { gt: start } }] },
      select: { vehicleId: true, userId: true, assignedAt: true, unassignedAt: true, notes: true,
                user: { select: { fullName: true } } },
    }),
    prisma.$queryRaw<Array<{ vehicle_id: string; first_at: Date; last_at: Date }>>`
      SELECT t.vehicle_id, min(t.captured_at) AS first_at, max(t.captured_at) AS last_at
        FROM vehicle_telemetries t JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND t.captured_at >= ${start} AND t.captured_at < ${end}
         AND t.speed_kmh > ${DRIVEN_KMH}
       GROUP BY t.vehicle_id, date_trunc('day', t.captured_at + interval '3 hours')`,
    prisma.speedingIncident.findMany({
      where:  { organisationId: orgId, startedAt: { gte: start, lt: end } },
      select: { vehicleId: true, startedAt: true, overByKmh: true },
    }),
    prisma.providerAlert.findMany({
      where:  { organisationId: orgId, type: 'HARSH_BRAKING', createdAt: { gte: start, lt: end } },
      select: { vehicleId: true, createdAt: true, raw: true },
    }),
  ])

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
  const names = new Map<string, string>()
  const inputs = new Map<string, Map<string, DayInput & { plates: Set<string> }>>()
  const slot = (driverId: string, name: string, day: string) => {
    names.set(driverId, name)
    let days = inputs.get(driverId)
    if (!days) inputs.set(driverId, days = new Map())
    let d = days.get(day)
    if (!d) days.set(day, d = { overspeeds: [], violations: [], plates: new Set() })
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

  const unattributed = { overspeed: 0, harshBrake: 0, dashcam: 0 }

  for (const s of speeding) {
    const a = holder(s.vehicleId, s.startedAt)
    if (!a) { unattributed.overspeed++; continue }
    slot(a.userId, a.user.fullName, dayOf(s.startedAt)).overspeeds.push({
      at: s.startedAt.toISOString(), vehicleId: s.vehicleId, plate: plate.get(s.vehicleId) ?? null, overKmh: s.overByKmh,
    })
  }

  const harshLimit = SCORE_RULES.safety.violations.harshBrake.overMs2
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

  const drivers: DriverScore[] = []
  for (const [driverId, days] of inputs) {
    const byDay: DriverDay[] = [...days].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, input]) => ({ day, plates: [...input.plates], ...scoreDay(input) }))
    const violations = Object.fromEntries(Object.keys(SCORE_RULES.safety.violations).map(k => [k, 0])) as Record<ViolationKind, number>
    const perMonth = new Map<string, number>()
    for (const d of byDay) {
      for (const e of d.events) if (e.rule === 'safety') violations[e.kind as ViolationKind]++
      perMonth.set(d.day.slice(0, 7), (perMonth.get(d.day.slice(0, 7)) ?? 0) + d.violations)
    }
    const speedPoints  = byDay.reduce((n, d) => n + d.speedPoints, 0)
    const safetyPoints = byDay.reduce((n, d) => n + d.safetyPoints, 0)
    const speedKes  = speedPoints * SCORE_RULES.speed.kesPerPoint
    const safetyKes = safetyPoints * SCORE_RULES.safety.kesPerPoint
    drivers.push({
      driverId, name: names.get(driverId) ?? '?', days: byDay.length,
      speedPoints, speedKes, safetyPoints, safetyKes, totalKes: speedKes + safetyKes,
      violations,
      tripPayDaysLost: byDay.filter(d => d.losesTripPay).length,
      months: [...perMonth].map(([month, n]) => ({ month, violations: n, standing: monthStanding(n) })),
      byDay,
    })
  }
  drivers.sort((a, b) => a.totalKes - b.totalKes || a.name.localeCompare(b.name))

  return {
    from: fromDay, to: toDay, rules: SCORE_RULES, drivers,
    coverage: { vehiclesDriven: drivenVehicles.size, vehiclesWithDriver: withDriver.size, unattributed, dashcam },
    manual: [
      // Clauses, not sentences: the page joins them into one ("The following
      // are not scored here: a; b; and c.").
      'fuel efficiency (§3.1), because fuel-probe readings are not yet reliable enough to base pay on',
      'vehicle care (§3.3), which requires the mechanic’s inspection score',
      'trip-wise pay, lunch allowance and attendance, which require trip and attendance records',
      'running a red light or driving without headlights, which neither the trackers nor the cameras can detect',
    ],
  }
}
