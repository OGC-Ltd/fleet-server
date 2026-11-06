// Gathers one organisation's shift for the end-of-shift report and hands it
// to the pure builder (end-of-shift.ts). Reads the same services the dashboard
// routes do, in-process:
//
//   telemetry getFleetSnapshot           units, drivers, zones they are in now, open dispatch
//   fuel repository                      refills and drains
//   incidents speedingSummary            overspeeding, a row per unit
//   notification reader                  HARSH_*, ZONE_EXIT / ZONE_ENTRY, SALE_DISPATCH
//   dashcam getAlarms                    phone, seatbelt, camera covered
//   weighments getWeighmentDay / bridges weighbridge tickets
//   geocode reverseGeocode               "Now near" for the units still out
//   telemetry + fuel ledger (report db)  each unit's distance and fuel burned
//
// A source that fails leaves its section empty rather than stopping the report;
// the failures are logged together.

import { prisma } from '../../lib/prisma.js'
import { reportDb } from '../../lib/report-db.js'
import { fuelBalance, asDaySeries } from '../fuel/fuel-balance.js'
import { trackDistanceKm } from '../trips/trip-report.build.js'
import { logger } from '../../lib/logger.js'
import { reverseGeocode } from '../../lib/geocode.js'
import { getNotifications } from '../../lib/notifications/notification.reader.js'
import type { NotificationItem } from '../../lib/notifications/notification-cache.js'
import { feedSourcesFor, feedGrantsFor } from '../../lib/authz/subject.js'
import { getFleetSnapshot } from '../telemetry/telemetry.service.js'
import { findAllFillings, findAllThefts } from '../fuel/fuel.repository.js'
import { speedingSummary } from '../incidents/incidents.service.js'
import { cameraCount, getAlarms } from '../dashcam/dashcam.service.js'
import { getWeighmentDay } from '../weighments/weighment.service.js'
import { getWeighbridges } from '../weighments/weighbridge.service.js'
import {
  buildEndOfShift, shiftStart, shiftEnd, type EndOfShift, type ShiftAlarm, type ShiftFilling, type ShiftSpeeding,
  type ShiftTheft, type ShiftTicket, type ShiftUnit, type ShiftUsage,
} from './end-of-shift.js'

const H = 3_600_000
const PAGES = 20
const HARSH_TYPES = ['HARSH_ACCELERATION', 'HARSH_BRAKING']

/** The fleet day (EAT) a moment falls on, YYYY-MM-DD. */
const fleetDay = (t: number) => new Date(t + 3 * H).toISOString().slice(0, 10)

/** The fleet days a span touches, oldest first. */
export function daysOf(from: number, to: number): string[] {
  const out: string[] = []
  for (let d = fleetDay(from); ; ) {
    out.push(d)
    if (d >= fleetDay(to)) break
    d = new Date(Date.parse(`${d}T12:00:00Z`) + 24 * H).toISOString().slice(0, 10)
  }
  return out
}

// Kenyan plates, as the dashboard reads them out of names like
// "Mahindra 9200 4WD KTCC 787D" (raitrack lib/plate).
const PLATE = /(?<![A-Za-z0-9])(K[A-Z]{2,3}) ?(\d{3}) ?([A-Z])(?![A-Z0-9])/
export function plateIn(...texts: unknown[]): string | null {
  for (const t of texts) {
    const m = typeof t === 'string' ? PLATE.exec(t) : null
    if (m) return `${m[1]} ${m[2]}${m[3]}`
  }
  return null
}

const toMs = (v: unknown): number | null => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(t) ? t : null
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** One snapshot row → the unit the report reasons about. */
export function toShiftUnit(raw: unknown): ShiftUnit {
  const v = raw as Record<string, any>
  const driver = typeof v.driver === 'string' && v.driver && v.driver !== 'Unassigned' ? v.driver : null
  const tag = v.trip?.externalId
  return {
    vehicleId: String(v.vehicleId),
    plate: plateIn(v.plate, v.name) ?? v.plate ?? String(v.vehicleId),
    driver,
    zones: v.zones ?? null,
    dispatch: tag != null && tag !== '' ? String(tag) : null,
    lat: num(v.lat),
    lng: num(v.lng),
    seenAt: toMs(v.capturedAt),
  }
}

/** Every page of a cursor list over the shift. */
async function allPages<T>(read: (cursor: string | undefined) => Promise<{ data: T[]; cursor: string | null; hasNextPage: boolean }>): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  for (let i = 0; i < PAGES; i++) {
    const page = await read(cursor)
    out.push(...page.data)
    if (!page.hasNextPage || !page.cursor) break
    cursor = page.cursor
  }
  return out
}

export interface LoadOptions {
  orgId: string
  /** The caller's vehicle scope; null sees the whole organisation. */
  vehicleIds: Set<string> | null
  /** The caller, for which feed sources they may read. */
  userId?: string | null
  now?: number
  /** A period picked on the Reports page; without it, today from midnight up to now. */
  period?: { from: number; to: number }
}

/** Everything the report is made from, for one organisation: today from midnight up to now, or the period given. */
export async function loadEndOfShift({ orgId, vehicleIds, userId = null, now = Date.now(), period }: LoadOptions): Promise<{ report: EndOfShift; failed: string[] }> {
  const from = period?.from ?? shiftStart(now)
  const to = period ? Math.min(period.to, now) : Math.min(now, shiftEnd(now))
  const fromDate = new Date(from), toDate = new Date(to)
  const days = daysOf(from, to)
  const inScope = (id: string | null | undefined) => !vehicleIds || (id != null && vehicleIds.has(id))
  const failed: string[] = []
  const note = <T>(name: string, fallback: T) => (err: unknown): T => {
    failed.push(name)
    logger.warn({ err, orgId }, `end of shift: ${name} not read`)
    return fallback
  }

  const [sources, grants] = userId
    ? await Promise.all([feedSourcesFor(userId, orgId), feedGrantsFor(userId, orgId)]).catch(() => [null, [] as string[]] as const)
    : [null, null] as const
  const feedOf = async (alertTypes: string[]): Promise<NotificationItem[]> => {
    const out: NotificationItem[] = []
    for (const day of days) {
      let before: Date | undefined
      for (let i = 0; i < PAGES; i++) {
        const page = await getNotifications(orgId, {
          limit: 500, before, alertTypes, day, vehicleIds, grants, ...(sources ? { sources } : {}),
        })
        out.push(...page.items)
        const last = page.items.at(-1)
        if (page.items.length < 500 || !last) break
        before = new Date(last.ts)
      }
    }
    return out
  }

  const snapshot = await getFleetSnapshot(orgId, vehicleIds).catch(note('vehicles', [] as unknown[]))
  const units = (Array.isArray(snapshot) ? snapshot : []).map(toShiftUnit)

  const [fillings, thefts, speeding, harsh, alarms, zones, tickets, sales, usage] = await Promise.all([
    allPages((cursor) => findAllFillings(orgId, { from: fromDate, to: toDate, limit: 200, cursor }))
      .then((rows) => rows.filter((r) => inScope(r.vehicleId)) as ShiftFilling[])
      .catch(note('refills', [] as ShiftFilling[])),
    allPages((cursor) => findAllThefts(orgId, { from: fromDate, to: toDate, limit: 200, cursor }))
      .then((rows) => rows.filter((r) => inScope(r.vehicleId)) as ShiftTheft[])
      .catch(note('fuel drains', [] as ShiftTheft[])),
    allPages((cursor) => speedingSummary(orgId, { from: fromDate, to: toDate, sort: 'count', limit: 200, cursor }))
      .then((rows) => rows.filter((r) => inScope(r.vehicleId)) as ShiftSpeeding[])
      .catch(note('overspeeding', [] as ShiftSpeeding[])),
    feedOf(HARSH_TYPES).catch(note('harsh driving', [] as NotificationItem[])),
    alarmsOf(orgId, vehicleIds, from).catch(note('dashcam alarms', null)),
    feedOf(['ZONE_EXIT', 'ZONE_ENTRY']).catch(note('geofence crossings', [] as NotificationItem[])),
    ticketsOf(orgId, days, inScope).catch(note('weighbridge', null)),
    feedOf(['SALE_DISPATCH']).catch(note('sales dispatches', [] as NotificationItem[])),
    usageOf(units.filter((u) => u.seenAt != null && u.seenAt >= from), from, to).catch(note('distance and fuel', null)),
  ])

  // Place names only for the units the report lists as still out.
  const first = buildEndOfShift({ from, to, units, zones })
  const out = new Set(first.outside.map((o) => o.plate))
  const places = await placesFor(units.filter((u) => out.has(u.plate))).catch(() => new Map<string, string>())

  if (failed.length) logger.warn({ orgId, failed }, 'end of shift: report made without some sources')
  return {
    report: buildEndOfShift({ from, to, units, fillings, thefts, speeding, harsh, alarms, zones, tickets, sales, places, usage }),
    failed,
  }
}

/**
 * Each unit's distance and fuel burned over the shift, worked out as the
 * recovery report works them out (operator, 7 Nov 2026): distance from the
 * moving stretches of the track (trip report), fuel as initial + filled -
 * theft - final (fuel-balance). Only units that reported in the shift are
 * read; the ledger is read once for them all, the track a few units at a time.
 */
async function usageOf(units: ShiftUnit[], from: number, to: number): Promise<ShiftUsage[]> {
  if (!units.length) return []
  const ids = units.map((u) => u.vehicleId)
  const db = reportDb()
  const [fillings, drains] = await Promise.all([
    db.fuelFilling.findMany({
      where: { vehicleId: { in: ids }, filledAt: { gte: new Date(from), lte: new Date(to) } },
      select: { vehicleId: true, filledAt: true, verdict: true, observedRiseMl: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
    }),
    db.fuelTheft.findMany({
      where: { vehicleId: { in: ids }, beganAt: { gte: new Date(from), lte: new Date(to) },
               OR: [{ drainCause: 'SIPHON' }, { reviewStatus: 'CONFIRMED_THEFT' }] },
      select: { vehicleId: true, beganAt: true, verdict: true, drainCause: true, cleanDropMl: true, measuredDropMl: true,
                stolenMl: true, finalFuelLevelMl: true, reviewStatus: true, dismissedAt: true },
    }),
  ])
  const group = <T extends { vehicleId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>()
    for (const r of rows) m.set(r.vehicleId, [...(m.get(r.vehicleId) ?? []), r])
    return m
  }
  const fillsOf = group(fillings), drainsOf = group(drains)

  const out: ShiftUsage[] = []
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const vehicleId = ids[next++]!
      const rows = await db.$queryRaw<Array<{ captured_at: Date; lat: number | null; lng: number | null; speed_kmh: number | null; fuel_level_ml: number | null }>>`
          SELECT captured_at, lat, lng, speed_kmh, fuel_level_ml
            FROM vehicle_telemetries
           WHERE vehicle_id = ${vehicleId} AND captured_at >= ${new Date(from)} AND captured_at <= ${new Date(to)}
           ORDER BY captured_at ASC`
      const track = rows.filter((r) => r.lat != null && r.lng != null)
        .map((r) => [r.captured_at.getTime(), r.lat!, r.lng!, r.speed_kmh, null] as [number, number, number, number | null, null])
      const bal = fuelBalance({
        readings: rows.map((r) => asDaySeries({ t: r.captured_at.getTime(), lat: r.lat, lng: r.lng, speedKmh: r.speed_kmh, fuelMl: r.fuel_level_ml })),
        fillings: (fillsOf.get(vehicleId) ?? []).map((f) => ({ ...f, at: f.filledAt.getTime() })),
        drains: (drainsOf.get(vehicleId) ?? []).map((d) => ({ ...d, at: d.beganAt.getTime() })),
        from, to: to + 1,
      })
      out.push({ vehicleId, km: trackDistanceKm(track), fuelL: bal.consumedL })
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker))
  return out
}

async function alarmsOf(orgId: string, scope: Set<string> | null, from: number): Promise<ShiftAlarm[] | null> {
  const cams = await cameraCount(orgId, scope).catch(() => 0)
  if (!cams) return null
  const answer = await getAlarms(orgId, scope, new Date(from).toISOString())
  return answer.incidents.map((a) => ({ code: a.code, label: a.label, occurredAt: a.occurredAt, vehicleId: a.vehicleId, plate: a.plate }))
}

async function ticketsOf(orgId: string, days: string[], inScope: (id: string | null | undefined) => boolean): Promise<ShiftTicket[] | null> {
  const bridges = await getWeighbridges(orgId).catch(() => [])
  const rows: ShiftTicket[] = []
  let centres = 0
  for (const day of days) {
    const res = await getWeighmentDay(orgId, { day })
    centres = Math.max(centres, res.centres?.length ?? 0)
    rows.push(...res.rows)
  }
  // A fleet with no bridge of its own gets no weighbridge section.
  if (!bridges.length && !centres && !rows.length) return null
  return rows.filter((r) => inScope(r.vehicleId))
}

/** Where each listed unit is now, by name ("Pemugi, Turbo"); else the coordinates stand in. */
async function placesFor(units: ShiftUnit[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = units.filter((u) => u.lat != null && u.lng != null)
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const u = list[next++]!
      const name = await reverseGeocode(u.lat!, u.lng!).catch(() => null)
      if (name) out.set(u.vehicleId, String(name).replace(/,\s*Kenya$/i, ''))
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return out
}

/** The organisation's name and the short code the report number carries. */
export async function orgHeading(orgId: string): Promise<{ name: string; short: string }> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true, code: true } })
  const name = org?.name ?? 'Fleet'
  return { name, short: String(org?.code ?? name).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'ORG' }
}
