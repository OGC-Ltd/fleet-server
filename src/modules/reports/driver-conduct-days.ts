/**
 * Driver Conduct a fleet day at a time (operator, 2026-11-25: "cache the
 * drivers conduct on a daily basis for a consolidated monthly driver conduct").
 *
 * A month's Driver Conduct Report read VSS a day at a time from the browser:
 * VSS answers one search every 10 s, so a month took about four minutes, and
 * past VSS's two weeks there was nothing to read. The dashcam alarms are saved
 * each night already (dashcam-capture), and the harsh driving is in
 * `notifications`. This builds, for each organisation and each past fleet day,
 * one row per vehicle: its harsh accelerations and brakes and its no seatbelt,
 * on phone and camera covered alarms, each by the time it happened, so the page
 * adds the days up in one request and keeps its own rules (the driver at the
 * time, an operator's entry matched to an alarm within 5 minutes).
 *
 * Built from our own tables only: nothing here asks VSS or Wialon. A day is
 * built again while its dashcam capture changes (late uploads, alarms typed
 * late) and for the last few days, when late notifications still arrive.
 *
 * Kept for the month and the four days after it: a month's days are cleared on
 * the 5th of the next month (operator, 2026-11-25), so last month's report can
 * still be made from them on the first days of the new one.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { dayWindow, fleetDayOf } from '../dashcam/dashcam-capture.js'

const DAY = 86_400_000

export const HARSH_TYPES = ['HARSH_ACCELERATION', 'HARSH_BRAKING'] as const
/** Dashcam alarm codes, as the page reads them (new-ui lib/fleetReports PHONE_CODES, SEATBELT_CODES, COVER_CODES). */
export const PHONE_CODES = [116, 264]
export const SEATBELT_CODES = [125, 51]
export const COVER_CODES = [123, 3]
export const KINDS = ['accel', 'brake', 'seatbelt', 'phone', 'covered'] as const
export type Kind = typeof KINDS[number]
export type Times = Record<Kind, number[]>

/** The longest stretch one request may ask for: a month and a day. */
export const MAX_DAYS = 31

const kindOfCode = (code: number): Kind | null =>
  PHONE_CODES.includes(code) ? 'phone' : SEATBELT_CODES.includes(code) ? 'seatbelt' : COVER_CODES.includes(code) ? 'covered' : null
const plateKey = (p: string | null | undefined) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The first fleet day still kept on `now`: the 1st of this month from the 5th
 * on, the 1st of last month before it.
 */
export function keepFrom(now = Date.now()): string {
  const today = fleetDayOf(now)
  const [y, m, d] = today.split('-').map(Number) as [number, number, number]
  const back = d >= 5 ? 0 : 1
  const first = new Date(Date.UTC(y, m - 1 - back, 1))
  return first.toISOString().slice(0, 10)
}

/** Fleet days from `from` to `to`, both included, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

let tablesReady: boolean | null = null
/** Whether the migrations have run (these tables and the dashcam ones). Until they have, nothing is built or read. */
export async function conductDaysReady(): Promise<boolean> {
  if (tablesReady) return true
  const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT to_regclass('public.driver_conduct_days') IS NOT NULL
       AND to_regclass('public.driver_conduct_built_days') IS NOT NULL
       AND to_regclass('public.dashcam_alarms') IS NOT NULL
       AND to_regclass('public.dashcam_capture_days') IS NOT NULL AS ok`
  tablesReady = Boolean(rows[0]?.ok)
  return tablesReady
}
/** For tests. */
export function resetConductDaysState(): void { tablesReady = null }

interface VehicleDay { vehicleId: string | null; plate: string; times: Times }

/** The rows of one day from its harsh notifications and saved alarms: one per vehicle. */
export function vehicleDays(
  harsh: Array<{ vehicleId: string | null; plate: string | null; alertType: string | null; occurredAt: Date }>,
  alarms: Array<{ vehicleId: string | null; plate: string; code: number; occurredAt: Date }>,
): Map<string, VehicleDay> {
  const out = new Map<string, VehicleDay>()
  const add = (vehicleId: string | null, plate: string | null, kind: Kind, t: number) => {
    const key = vehicleId || (plateKey(plate) ? `plate:${plateKey(plate)}` : null)
    if (!key) return
    let v = out.get(key)
    if (!v) out.set(key, (v = { vehicleId: vehicleId || null, plate: plate ?? '', times: { accel: [], brake: [], seatbelt: [], phone: [], covered: [] } }))
    if (!v.plate && plate) v.plate = plate
    v.times[kind].push(t)
  }
  for (const h of harsh) {
    const kind = h.alertType === 'HARSH_ACCELERATION' ? 'accel' : h.alertType === 'HARSH_BRAKING' ? 'brake' : null
    if (kind) add(h.vehicleId, h.plate, kind, h.occurredAt.getTime())
  }
  for (const a of alarms) {
    const kind = kindOfCode(a.code)
    if (kind) add(a.vehicleId, a.plate, kind, a.occurredAt.getTime())
  }
  for (const v of out.values()) for (const k of KINDS) v.times[k].sort((x, y) => x - y)
  return out
}

export interface BuiltDay { orgId: string; day: string; vehicles: number; harsh: number; alarms: number; captured: boolean }

/** Build one organisation's fleet day: its rows replaced, and the day marked built. */
export async function buildDay(orgId: string, day: string, now = Date.now()): Promise<BuiltDay> {
  const { from, to } = dayWindow(day)
  if (to > now) throw new Error(`${day} has not ended`)
  const span = { gte: new Date(from), lt: new Date(to) }
  const [harsh, alarms, capture] = await Promise.all([
    prisma.notification.findMany({
      where: { organisationId: orgId, alertType: { in: [...HARSH_TYPES] }, occurredAt: span },
      select: { vehicleId: true, plate: true, alertType: true, occurredAt: true },
    }),
    prisma.dashcamAlarm.findMany({
      where: { organisationId: orgId, occurredAt: span, code: { in: [...PHONE_CODES, ...SEATBELT_CODES, ...COVER_CODES] } },
      select: { vehicleId: true, plate: true, code: true, occurredAt: true },
    }),
    prisma.dashcamCaptureDay.findUnique({ where: { organisationId_day: { organisationId: orgId, day } } }),
  ])
  const rows = [...vehicleDays(harsh, alarms)].map(([vehicleKey, v]) => ({
    organisationId: orgId, day, vehicleKey, vehicleId: v.vehicleId, plate: v.plate,
    accel: v.times.accel.length, brake: v.times.brake.length,
    seatbelt: v.times.seatbelt.length, phone: v.times.phone.length, covered: v.times.covered.length,
    times: v.times,
  }))
  const captured = Boolean(capture && !capture.partial)
  const built = {
    builtAt: new Date(now), captured, captureAt: capture?.capturedAt ?? null, untyped: capture?.untyped ?? 0,
    harsh: harsh.length, alarms: alarms.length,
  }
  await prisma.$transaction([
    prisma.driverConductDay.deleteMany({ where: { organisationId: orgId, day } }),
    ...(rows.length ? [prisma.driverConductDay.createMany({ data: rows })] : []),
    prisma.driverConductBuiltDay.upsert({
      where: { organisationId_day: { organisationId: orgId, day } },
      create: { organisationId: orgId, day, ...built },
      update: built,
    }),
  ])
  return { orgId, day, vehicles: rows.length, harsh: harsh.length, alarms: alarms.length, captured }
}

/**
 * Which of an organisation's days to build: every past day kept and within a
 * month that is not built, the last `rebuild` days again (late notifications),
 * and any day whose dashcam capture is newer than its build.
 */
export function daysToBuild(
  candidates: string[],
  built: Map<string, { captureAt: Date | null }>,
  captures: Map<string, { capturedAt: Date }>,
  rebuild: number,
): string[] {
  const recent = new Set(candidates.slice(-rebuild))
  return candidates.filter((day) => {
    const b = built.get(day)
    if (!b || recent.has(day)) return true
    const c = captures.get(day)
    return Boolean(c && (!b.captureAt || c.capturedAt.getTime() > b.captureAt.getTime()))
  })
}

export interface ConductDaysCycle {
  keepFrom: string
  expired: number
  built: BuiltDay[]
  failed: Array<{ org: string; day: string; error: string }>
  skipped?: 'no-tables'
  ms: number
}

/** One cycle: clear what has expired, then build what is missing or stale, for every organisation. */
export async function runConductDays({ now = Date.now(), rebuild = 3 }: { now?: number; rebuild?: number } = {}): Promise<ConductDaysCycle> {
  const startedAt = Date.now()
  const keep = keepFrom(now)
  const cycle: ConductDaysCycle = { keepFrom: keep, expired: 0, built: [], failed: [], ms: 0 }
  if (!(await conductDaysReady())) {
    cycle.skipped = 'no-tables'
    logger.warn('Driver conduct days: tables not there yet (migration not run): nothing built')
    return cycle
  }
  const gone = await prisma.$transaction([
    prisma.driverConductDay.deleteMany({ where: { day: { lt: keep } } }),
    prisma.driverConductBuiltDay.deleteMany({ where: { day: { lt: keep } } }),
  ])
  cycle.expired = gone[0].count

  const yesterday = fleetDayOf(dayWindow(fleetDayOf(now)).from - DAY / 2)
  const monthBack = fleetDayOf(dayWindow(fleetDayOf(now)).from - MAX_DAYS * DAY + DAY / 2)
  const first = keep > monthBack ? keep : monthBack
  const candidates = first <= yesterday ? daysBetween(first, yesterday) : []
  if (!candidates.length) { cycle.ms = Date.now() - startedAt; return cycle }

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } })
  for (const o of orgs) {
    const [built, captures] = await Promise.all([
      prisma.driverConductBuiltDay.findMany({ where: { organisationId: o.id, day: { in: candidates } }, select: { day: true, captureAt: true } }),
      prisma.dashcamCaptureDay.findMany({ where: { organisationId: o.id, day: { in: candidates } }, select: { day: true, capturedAt: true } }),
    ])
    const todo = daysToBuild(candidates, new Map(built.map((b) => [b.day, b])), new Map(captures.map((c) => [c.day, c])), rebuild)
    for (const day of todo) {
      try {
        cycle.built.push(await buildDay(o.id, day, now))
      } catch (err) {
        // One day failing must not abandon the rest; the next cycle builds it again.
        cycle.failed.push({ org: o.code, day, error: err instanceof Error ? err.message : String(err) })
        logger.warn({ err, org: o.code, day }, 'Driver conduct days: day not built; tried again next cycle')
      }
    }
  }
  cycle.ms = Date.now() - startedAt
  logger.info({ keepFrom: keep, expired: cycle.expired, built: cycle.built.length, failed: cycle.failed.length, ms: cycle.ms }, 'Driver conduct days cycle complete')
  return cycle
}

export interface ConductDaysAnswer {
  /** The days built, whole or not; a day not listed is read live by the page. */
  days: Array<{ day: string; builtAt: number; captured: boolean; untyped: number }>
  rows: Array<{ day: string; vehicleId: string | null; plate: string; times: Times }>
  keepFrom: string
}

/**
 * An organisation's built days from `from` to `to` (fleet days, both
 * included, a month and a day at most). A scoped reader sees only the
 * vehicles in scope, and no row naming none (the notifications' rule).
 */
export async function readConductDays(orgId: string, from: string, to: string, vehicleIds: Set<string> | null = null, now = Date.now()): Promise<ConductDaysAnswer> {
  const keep = keepFrom(now)
  const lo = from < keep ? keep : from
  const empty = { days: [], rows: [], keepFrom: keep }
  if (to < lo || !(await conductDaysReady())) return empty
  const [days, rows] = await Promise.all([
    prisma.driverConductBuiltDay.findMany({ where: { organisationId: orgId, day: { gte: lo, lte: to } }, orderBy: { day: 'asc' } }),
    prisma.driverConductDay.findMany({
      where: { organisationId: orgId, day: { gte: lo, lte: to }, ...(vehicleIds ? { vehicleId: { in: [...vehicleIds] } } : {}) },
      select: { day: true, vehicleId: true, plate: true, times: true },
      orderBy: [{ day: 'asc' }, { vehicleKey: 'asc' }],
    }),
  ])
  return {
    days: days.map((d) => ({ day: d.day, builtAt: d.builtAt.getTime(), captured: d.captured, untyped: d.untyped })),
    rows: rows.map((r) => ({ day: r.day, vehicleId: r.vehicleId, plate: r.plate, times: r.times as unknown as Times })),
    keepFrom: keep,
  }
}
