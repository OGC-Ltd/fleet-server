/**
 * Save dashcam alarms from VSS into our own tables (operator, 2026-11-24).
 *
 * VSS keeps alarms about two weeks (read 2026-11-24: Aquamist's 11 Nov there,
 * 8 Nov gone), so a month of Driver conduct could never count seatbelt, phone
 * or camera covered past that. This keeps the NUMBERS for good: one row per
 * alarm (`dashcam_alarms`, keyed by VSS's own guid) and one per organisation
 * per day (`dashcam_capture_days`) saying the day was captured and what it held.
 * No clips or photos: those stay in VSS.
 *
 * A day is read through searchAlarms' one-day window (dashcam.service, #144), so
 * every alarm's type is looked up. Capturing a day again is safe: alarms
 * already held are not written twice, and one held without a type takes the
 * type when VSS gives it.
 *
 * Each capture also caches the whole day, media links included, in Redis for
 * VSS_CACHE_DAYS (dashcam-store), which is what getAlarms serves. Only the
 * vss-worker process captures (src/vss-worker.ts).
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { searchAlarms, cameraCount, type DashcamIncident } from './dashcam.service.js'
import { readDays, storeDay } from './dashcam-store.js'
import { dayWindow, fleetDayOf } from './fleet-day.js'

// Kept exported from here: the back-fill script and the tests import them from this module.
export { dayWindow, fleetDayOf, lastDays } from './fleet-day.js'

let tablesReady: boolean | null = null
/** Whether the migration has run. Until it has, capturing does nothing (deploy before migrate is safe). */
export async function dashcamTablesReady(): Promise<boolean> {
  if (tablesReady) return true
  const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT to_regclass('public.dashcam_alarms') IS NOT NULL AND to_regclass('public.dashcam_capture_days') IS NOT NULL AS ok`
  tablesReady = Boolean(rows[0]?.ok)
  return tablesReady
}
/** For tests. */
export function resetCaptureState(): void { tablesReady = null }

export interface DayCapture {
  orgId: string
  day: string
  cameras: number
  alarms: number
  added: number
  typed: number
  untyped: number
  partial: boolean
  skipped?: 'no-tables' | 'no-cameras' | 'future'
}

const rowOf = (orgId: string, i: DashcamIncident, now: Date) => ({
  id: i.id,
  organisationId: orgId,
  vehicleId: i.vehicleId || null,
  plate: i.plate ?? '',
  deviceId: i.deviceId ?? '',
  occurredAt: new Date(i.occurredAt as string),
  code: i.code || 0,
  label: i.code ? i.label : '',
  group: i.code ? i.group : '',
  severity: i.code ? i.severity : '',
  category: i.code ? i.category : '',
  speedKmh: i.speed ?? null,
  lat: i.lat ?? null,
  lng: i.lng ?? null,
  typedAt: i.code ? now : null,
})

/**
 * Capture one organisation's alarms for one fleet day. `apply: false` reads
 * VSS and reports what it would write, writing nothing.
 */
export async function captureDay(orgId: string, day: string, { apply = true, now = Date.now() } = {}): Promise<DayCapture> {
  const base = { orgId, day, cameras: 0, alarms: 0, added: 0, typed: 0, untyped: 0, partial: false }
  if (apply && !(await dashcamTablesReady())) return { ...base, skipped: 'no-tables' }
  const { from, to } = dayWindow(day)
  if (from >= now) return { ...base, skipped: 'future' }

  const answer = await searchAlarms(orgId, null, new Date(from).toISOString(), new Date(Math.min(to, now)).toISOString())
  if (!answer.cameras) return { ...base, skipped: 'no-cameras' }
  // Only the day's own alarms (VSS times, a minute or two either side of midnight, can stray)
  const list = answer.incidents.filter((i) => i.occurredAt && fleetDayOf(Date.parse(i.occurredAt)) === day)
  const untyped = list.filter((i) => !i.code).length
  const out: DayCapture = { ...base, cameras: answer.cameras, alarms: list.length, untyped, partial: Boolean(answer.partial) }
  if (!apply) return out

  // The cache the Alarms page and the reports read (vss-worker): the whole day, clips and photos included.
  // Merged with what it held: a capture VSS cut short (partial) must not drop alarms an earlier one had.
  const prev = (await readDays(orgId, [day], now)).get(day)
  const ids = new Set(list.map((i) => i.id))
  const incidents = [...list, ...(prev?.incidents.filter((i) => !ids.has(i.id)) ?? [])]
    .sort((x, y) => String(y.occurredAt).localeCompare(String(x.occurredAt)))
  await storeDay(orgId, day, { cameras: answer.cameras, incidents, partial: out.partial, through: Math.min(to, now), cachedAt: now })

  const at = new Date(now)
  const rows = list.map((i) => rowOf(orgId, i, at))
  for (let k = 0; k < rows.length; k += 500) {
    const r = await prisma.dashcamAlarm.createMany({ data: rows.slice(k, k + 500), skipDuplicates: true })
    out.added += r.count
  }
  // Held without a type, typed now: one update per type (a handful a day)
  const byCode = new Map<number, DashcamIncident[]>()
  for (const i of list) if (i.code) byCode.set(i.code, [...(byCode.get(i.code) ?? []), i])
  for (const [code, group] of byCode) {
    const first = group[0]!
    const r = await prisma.dashcamAlarm.updateMany({
      where: { id: { in: group.map((i) => i.id) }, organisationId: orgId, code: 0 },
      data: { code, label: first.label, group: first.group, severity: first.severity, category: first.category, typedAt: at },
    })
    out.typed += r.count
  }
  await prisma.dashcamCaptureDay.upsert({
    where: { organisationId_day: { organisationId: orgId, day } },
    create: { organisationId: orgId, day, alarms: list.length, untyped, partial: out.partial, capturedAt: at },
    update: { alarms: list.length, untyped, partial: out.partial, capturedAt: at },
  })
  return out
}

/** The organisations with at least one dashcam paired. */
export async function organisationsWithCameras(): Promise<Array<{ id: string; code: string }>> {
  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } })
  const out: Array<{ id: string; code: string }> = []
  for (const o of orgs) {
    try {
      if (await cameraCount(o.id, null)) out.push(o)
    } catch (err) {
      logger.warn({ err, org: o.code }, 'dashcam capture: cameras could not be counted — organisation skipped this cycle')
    }
  }
  return out
}

/**
 * Of these fleet days, the ones still to capture for an organisation: never
 * captured, or captured while VSS cut the search short (partial).
 */
export async function missedDays(orgId: string, days: string[]): Promise<string[]> {
  if (!days.length) return []
  const held = await prisma.dashcamCaptureDay.findMany({
    where: { organisationId: orgId, day: { in: days } },
    select: { day: true, partial: true },
  })
  const done = new Set(held.filter((h) => !h.partial).map((h) => h.day))
  return days.filter((d) => !done.has(d))
}
