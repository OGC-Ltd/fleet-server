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
//
// A source that fails leaves its section empty rather than stopping the report;
// the failures are logged together.

import { prisma } from '../../lib/prisma.js'
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
  buildEndOfShift, shiftStart, type EndOfShift, type ShiftAlarm, type ShiftFilling, type ShiftSpeeding,
  type ShiftTheft, type ShiftTicket, type ShiftUnit,
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
}

/** Everything the report is made from, for one organisation, 06:00 to now. */
export async function loadEndOfShift({ orgId, vehicleIds, userId = null, now = Date.now() }: LoadOptions): Promise<{ report: EndOfShift; failed: string[] }> {
  const from = shiftStart(now)
  const to = now
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

  const [fillings, thefts, speeding, harsh, alarms, zones, tickets, sales] = await Promise.all([
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
  ])

  // Place names only for the units the report lists as still out.
  const first = buildEndOfShift({ from, to, units, zones })
  const out = new Set(first.outside.map((o) => o.plate))
  const places = await placesFor(units.filter((u) => out.has(u.plate))).catch(() => new Map<string, string>())

  if (failed.length) logger.warn({ orgId, failed }, 'end of shift: report made without some sources')
  return {
    report: buildEndOfShift({ from, to, units, fillings, thefts, speeding, harsh, alarms, zones, tickets, sales, places }),
    failed,
  }
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
