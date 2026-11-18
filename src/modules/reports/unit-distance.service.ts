/**
 * Each unit's distance over one fleet day, by its tracker's own odometer
 * (Weighbridges › Metrics, operator 18 Nov 2026: "we need to pull that from
 * wialon; if we don't have it we pull, then store").
 *
 * The odometer (Teltonika io_16) is stored per fix from 18 Nov 2026 on
 * (VehicleTelemetry.odometerM). For a unit-day that has no stored reading, a day
 * before the column or one whose rows came in without it, the unit's Wialon
 * messages for the day are read, each reading is written onto our row of the
 * same second (the rows carry the tracker's own time, so the match is exact),
 * and the distance is worked out from Wialon's messages, which are the fuller
 * set: KTCC 787D had 2,180 messages on 17 Nov against our 1,374 rows. The next
 * read of that day is answered from the database.
 *
 * A unit with no odometer, on Wialon or off it, keeps the GPS sum, as the Fuel
 * Consumption Rate report does (pickDayKm). A unit-day is pulled when fewer
 * than FILL_COVERAGE of its rows carry a reading, not only when none do: the
 * deploy day (18 Nov 2026) has three hours of rows from before the column, and
 * two live readings must not stop those being filled (KTCC 861B). Wialon is
 * asked at most once per unit-day per MISS_TTL_MS, whether it answered or not;
 * a pulled figure goes into the 7-day day-distance cache (day-km.cache), so a
 * settled day reads the same the next time, from the cache. No more than
 * FILLS_AT_ONCE units are read at a time across the server, and one request
 * fills for at most BUDGET_MS; what is left is answered `pending`, for the page
 * to ask again, so a long fill never runs into the proxy's timeout.
 */

import { prisma } from '../../lib/prisma.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { env } from '../../config/env.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import { readOdometerM } from '../../providers/wialon/wialon.sensors.js'
import { wialonUnitId } from '../fuel/fuel-sync.service.js'
import { cachedDayKmEvidence, pickDayKm, ODO_MAX_KMH, type DayKmEvidence, type DistanceSource } from './range-reports.service.js'
import { keepDayKm, SETTLE_MS } from './day-km.cache.js'

const PAGE = 20_000
/** A day at one message a second, with room to spare. */
const MAX_MESSAGES = 100_000
export const MISS_TTL_MS = 6 * 3_600_000
/** Below this share of a day's rows carrying a reading, the day is pulled from Wialon. */
export const FILL_COVERAGE = 0.9
const FILLS_AT_ONCE = 3
export const BUDGET_MS = 35_000
export const MAX_UNITS = 500

/** One odometer reading: the message's time in unix seconds, and metres. */
export interface OdoReading { t: number; m: number }

/**
 * The odometer's own count over a day's readings, km: each rise between
 * consecutive readings, never a fall (a reset) nor a rise faster than
 * ODO_MAX_KMH (a glitch). The same rule as dayKm's SQL.
 */
export function odoKmOf(readings: OdoReading[]): number {
  const r = [...readings].sort((a, b) => a.t - b.t)
  let m = 0
  for (let i = 1; i < r.length; i++) {
    const dm = r[i]!.m - r[i - 1]!.m
    const ds = r[i]!.t - r[i - 1]!.t
    if (dm > 0 && ds > 0 && (dm / ds) * 3.6 <= ODO_MAX_KMH) m += dm
  }
  return Math.round(m / 100) / 10
}

/** The unit's Wialon messages over [fromSec, toSec): the odometer readings, and how many messages. */
async function loadDayOdometer(wialonUnit: number, fromSec: number, toSec: number): Promise<{ readings: OdoReading[]; messages: number }> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const client = new WialonClient(token, env.WIALON_API_URL)
  const readings: OdoReading[] = []
  let messages = 0
  try {
    // flags 1 / mask 0xFF01: data messages only, as the usage review reads them.
    const loaded = await client.call<{ count?: number }>('messages/load_interval', {
      itemId: wialonUnit, timeFrom: fromSec, timeTo: toSec - 1, flags: 1, flagsMask: 0xFF01, loadCount: 0,
    })
    const total = Math.min(loaded.count ?? 0, MAX_MESSAGES)
    for (let i = 0; i < total; i += PAGE) {
      const page = await client.call<Record<string, { t?: number; p?: Record<string, unknown> }> | { t?: number; p?: Record<string, unknown> }[]>(
        'messages/get_messages', { indexFrom: i, indexTo: Math.min(i + PAGE, total) - 1 })
      for (const msg of Array.isArray(page) ? page : Object.values(page)) {
        if (typeof msg.t !== 'number') continue
        messages += 1
        const m = readOdometerM(msg.p)
        if (m != null) readings.push({ t: msg.t, m })
      }
    }
    await client.call('messages/unload', {}).catch(() => { /* best effort */ })
    return { readings, messages }
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

/** Writes the readings onto the unit's rows of the same second that have none. Returns the rows written. */
async function storeReadings(vehicleId: string, readings: OdoReading[]): Promise<number> {
  if (!readings.length) return 0
  return prisma.$executeRaw`
    UPDATE vehicle_telemetries t SET odometer_m = u.o
      FROM unnest(${readings.map((r) => r.t)}::float8[], ${readings.map((r) => r.m)}::float8[]) AS u(s, o)
     WHERE t.vehicle_id = ${vehicleId}
       AND t.captured_at = (to_timestamp(u.s) AT TIME ZONE 'UTC')
       AND t.odometer_m IS NULL`
}

/** When each unit-day was last asked of Wialon, answered or not. */
const tried = new Map<string, number>()
let running = 0
const waiting: (() => void)[] = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= FILLS_AT_ONCE) await new Promise<void>((r) => waiting.push(r))
  running += 1
  try { return await fn() } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/** Does this unit-day need Wialon: a unit on Wialon whose rows mostly carry no reading, not asked lately? */
export const needsFill = (e: DayKmEvidence | undefined, wialonUnit: number | null, triedAt: number | undefined, now: number) => {
  const readings = e?.odoReadings ?? 0
  return wialonUnit != null
    && (readings < 2 || readings < FILL_COVERAGE * (e?.fixes ?? 0))
    && (triedAt == null || now - triedAt >= MISS_TTL_MS)
}

export interface UnitDistanceRow {
  vehicleId: string
  distanceKm: number
  source: DistanceSource
  /** Its odometer is still to be read from Wialon: ask again. */
  pending: boolean
}

export async function unitDistance(orgId: string, scope: Set<string> | null, day: string, vehicleIds: string[], now = Date.now()) {
  const bounds = fleetDayBounds(day)
  if (!bounds) throw new BadRequestError('A fleet day is YYYY-MM-DD')
  if (bounds.from.getTime() > now) throw new BadRequestError('That day has not begun')
  const ids = [...new Set(vehicleIds)].filter((id) => !scope || scope.has(id)).slice(0, MAX_UNITS)
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, id: { in: ids } },
    select: { id: true, deviceId: true },
  })
  // From the 7-day cache where it holds the unit-day (day-km.cache), else the database
  const evidence = await cachedDayKmEvidence(vehicles.map((v) => v.id), day, now)
  const settled = bounds.to.getTime() <= now - SETTLE_MS
  const fromSec = Math.floor(bounds.from.getTime() / 1000)
  const toSec = Math.ceil(Math.min(bounds.to.getTime(), now) / 1000)
  const deadline = now + BUDGET_MS

  const filled = new Map<string, DayKmEvidence>()
  const pending = new Set<string>()
  await Promise.all(vehicles.map(async (v) => {
    const unit = wialonUnitId(v.deviceId)
    const key = `${v.id}|${day}`
    if (!needsFill(evidence.get(v.id), unit, tried.get(key), now)) return
    if (Date.now() >= deadline) { pending.add(v.id); return }
    await slot(async () => {
      if (Date.now() >= deadline) { pending.add(v.id); return }
      try {
        const { readings, messages } = await loadDayOdometer(unit!, fromSec, toSec)
        tried.set(key, Date.now())
        if (readings.length < 2) return
        await storeReadings(v.id, readings)
        const e = { gpsKm: evidence.get(v.id)?.gpsKm ?? 0, odoKm: odoKmOf(readings), odoReadings: readings.length, fixes: messages }
        filled.set(v.id, e)
        // The pulled figure replaces the cached one, so the next read has it without Wialon
        // or the database, even where Wialon's times did not meet our rows
        if (settled) await keepDayKm([[v.id, e]], day, now)
      } catch {
        tried.set(key, Date.now())
      }
    })
  }))

  const rows: UnitDistanceRow[] = vehicles.map((v) => {
    const e = filled.get(v.id) ?? evidence.get(v.id)
    const d = e ? pickDayKm(e) : { km: 0, source: 'gps' as const }
    return { vehicleId: v.id, distanceKm: Math.round(d.km * 10) / 10, source: d.source, pending: pending.has(v.id) }
  })
  return { day, rows, pending: pending.size, filled: filled.size }
}

/** Tests only. */
export function _clearOdoMisses() { tried.clear() }
