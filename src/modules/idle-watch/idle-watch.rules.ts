/**
 * The idle watch's rules: Menengai's listed units standing still too long
 * (fleet list of 10 Nov 2026; first built in the browser, new-ui PR #56).
 *
 * A unit is idle when it has not moved for 2 hours of WORKING time (3 until
 * 2026-11-13, when the operator lowered it):
 *   - working time is the day shift, 07:30 to 19:30 Nairobi time, so a truck
 *     parked at 18:00 and away at 08:00 has stood 1 h, and is never flagged;
 *   - a unit in the yard or a depot (MORL or the Nairobi depot, 1 km round
 *     each, as the stop watch has them) is where it belongs, and is not idle;
 *   - the stop time is the server's own (lib/movement-state), not when some
 *     browser first saw the unit stopped;
 *   - a tracker silent for a day is "not reporting", not idle: its position
 *     says nothing about now.
 * At 6 hours of working time the alert turns critical.
 *
 * Pure: no database, no network.
 */

import { placeAt, plateIn, type Place } from '../stop-watch/stop-watch.rules.js'

export const ORG_CODE = 'MENENGAI'
export const IDLE_MS = 2 * 3_600_000
export const CRITICAL_MS = 6 * 3_600_000
/** Silent longer than this: not reporting, not judged (new-ui lib/vehicleMap DARK_AFTER_MS). */
export const DARK_MS = 24 * 3_600_000
/** The day shift, in hours of Nairobi time (operator, 2 Nov 2026: 7:30hrs to 19:30hrs). */
export const WORK_HOURS = { start: 7.5, end: 19.5 }
/** Standing: slower than this (km/h), the app's moving speed (new-ui lib/vehicleDay MOVING_KMH). */
const MOVING_KMH = 3

const HOUR = 3_600_000
const DAY = 24 * HOUR
const OFFSET = 3 * HOUR   // Nairobi, UTC+3 all year
/** Days of stop looked back over at most: enough for any stop worth an alert. */
const MAX_DAYS = 60

/** The units watched, as the fleet list of 10 Nov 2026 gives them. */
export const IDLE_UNITS: readonly { plate: string; size: string; designation: string }[] = [
  { plate: 'KCE 780B', size: 'PROBOX', designation: 'GT/MT' },
  { plate: 'KCC 348A', size: 'PICKUP', designation: 'GT/MT' },
  { plate: 'KCC 345A', size: 'PICKUP', designation: 'GT/MT' },
  { plate: 'KCF 483V', size: 'PICKUP', designation: 'GT/MT' },
  { plate: 'KCB 123P', size: 'HYUNDAI', designation: 'GT/MT' },
  { plate: 'KCB 234J', size: 'HYUNDAI', designation: 'GT/MT' },
  { plate: 'KCB 345K', size: 'HYUNDAI', designation: 'GT/MT' },
  { plate: 'KCH 467T', size: 'HINO', designation: 'GT/MT' },
  { plate: 'KCH 474T', size: 'HINO', designation: 'GT/MT' },
  { plate: 'KCH 473T', size: 'HINO', designation: 'GT/MT' },
  { plate: 'KCH 502T', size: 'HINO', designation: 'GT/MT' },
  { plate: 'KDE 123E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 125E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 126E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 130E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 132E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 133E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 135E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 136E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 137E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 138E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 139E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDE 145E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KDM 124L', size: 'HINO', designation: 'RETAIL' },
  { plate: 'KDM 154L', size: 'HINO', designation: 'RETAIL' },
]

/** A unit as the fleet snapshot has it, with its current run (lib/movement-state). */
export interface IdleUnit {
  vehicleId: string
  plate?: string | null
  name?: string | null
  lat: number | null
  lng: number | null
  speedKmh: number | null
  engineOn?: boolean | null
  capturedAt: string | null
  movement?: { state: string; since: string; exact?: boolean } | null
}

export interface IdleAlert {
  /** One stop of one unit: the same key while it stands, a new one after it moves. */
  key: string
  vehicleId: string
  plate: string
  size: string
  designation: string
  /** When it stopped; `sinceExact` false: at least this long (the server did not see it stop). */
  since: number
  sinceExact: boolean
  /** Working time stood (07:30–19:30), the rule's measure; `standingMs` is the whole stop. */
  idleMs: number
  standingMs: number
  severity: 'warning' | 'critical'
  lat: number
  lng: number
  engineOn: boolean | null
  lastSeenAt: number | null
}

export interface IdleWatch {
  alerts: IdleAlert[]
  /** Listed units whose tracker has been silent a day or more, longest first. */
  notReporting: { plate: string; vehicleId: string; lastSeenAt: number | null }[]
  /** Listed plates no tracked unit carries. */
  notOnPlatform: string[]
}

const key = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * Working time inside [from, to): the day shift of each Nairobi day the span
 * touches. A stop over a weekend counts its weekdays' and weekend's shifts
 * alike: the fleet runs every day.
 */
export function workingMs(from: number, to: number, hours = WORK_HOURS): number {
  if (!(to > from)) return 0
  const start = Math.max(from, to - MAX_DAYS * DAY)
  let total = 0
  const first = Math.floor((start + OFFSET) / DAY) * DAY - OFFSET   // Nairobi midnight on or before `start`
  for (let d = first; d < to; d += DAY) {
    const a = Math.max(start, d + hours.start * HOUR)
    const b = Math.min(to, d + hours.end * HOUR)
    if (b > a) total += b - a
  }
  return total
}

/** "3 h 05 min", "1 d 4 h". */
export function idleWords(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  if (d) return `${d} d ${h} h`
  if (!h) return `${min} min`
  return min % 60 ? `${h} h ${String(min % 60).padStart(2, '0')} min` : `${h} h`
}

/**
 * The listed units idle now, longest first, with the listed units the rule
 * cannot judge. `excluded`: where standing is not idle (the yard and depots).
 */
export function idleUnits(
  units: readonly IdleUnit[],
  { excluded = [], now = Date.now(), list = IDLE_UNITS }: { excluded?: readonly Place[]; now?: number; list?: typeof IDLE_UNITS } = {},
): IdleWatch {
  const byPlate = new Map<string, IdleUnit>()
  for (const u of units) {
    const k = key(plateIn(u.plate, u.name) ?? u.plate)
    if (k && !byPlate.has(k)) byPlate.set(k, u)
  }
  const alerts: IdleAlert[] = []
  const notReporting: IdleWatch['notReporting'] = []
  const notOnPlatform: string[] = []
  for (const item of list) {
    const u = byPlate.get(key(item.plate))
    if (!u) { notOnPlatform.push(item.plate); continue }
    const seen = u.capturedAt ? Date.parse(u.capturedAt) : NaN
    const lastSeenAt = Number.isFinite(seen) ? seen : null
    if (lastSeenAt == null || now - lastSeenAt >= DARK_MS) {
      notReporting.push({ plate: item.plate, vehicleId: u.vehicleId, lastSeenAt })
      continue
    }
    if (!Number.isFinite(u.lat) || !Number.isFinite(u.lng)) continue
    if (u.movement?.state === 'moving' || Math.round(u.speedKmh ?? 0) >= MOVING_KMH) continue
    const since = Date.parse(u.movement?.since ?? '')
    if (!Number.isFinite(since)) continue
    const lat = u.lat as number
    const lng = u.lng as number
    if (placeAt(lat, lng, excluded)) continue
    const idleMs = workingMs(since, now)
    if (idleMs < IDLE_MS) continue
    alerts.push({
      key: `${u.vehicleId}|idle|${since}`,
      vehicleId: u.vehicleId,
      plate: item.plate,
      size: item.size,
      designation: item.designation,
      since,
      sinceExact: u.movement?.exact !== false,
      idleMs,
      standingMs: now - since,
      severity: idleMs >= CRITICAL_MS ? 'critical' : 'warning',
      lat,
      lng,
      engineOn: u.engineOn ?? null,
      lastSeenAt,
    })
  }
  alerts.sort((a, b) => b.idleMs - a.idleMs)
  notReporting.sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0))
  return { alerts, notReporting, notOnPlatform }
}
