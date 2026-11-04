/**
 * The Speed Report (operator, 4 Nov 2026; West Kenya's daily Wialon sheet): one
 * row for each unit that went over its limit on a fleet day.
 *
 * Read from Wialon's own messages and not from speeding_incidents or our
 * telemetry. Those are thinned to one row per 15 s, and incidents only count
 * three frames or more: on 30 Oct our rows read KDW 648X's peak as 111 where the
 * tracker sent 122, and found 12 of the sheet's 43 units. Wialon's messages gave
 * the sheet's figures for all 43: occurrences and peak exactly, distance within
 * 0.1 km, mileage within 0.5%. A unit Wialon does not carry, or cannot be read,
 * comes from our telemetry and says so.
 *
 *   Limit        the org's rule where it names this type (West Kenya's listed
 *                light vehicles, 110), else the limit set on the Wialon unit, as
 *                the sheet has it, else the limit the alerts use.
 *   Occurrence   an unbroken run over the limit, of two messages at least: a
 *                single message has no length to measure and the sheet leaves it out.
 *   Distance     along the messages inside those runs.
 *   Mileage      along every message of the day that was moving.
 */
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { reportDb } from '../../lib/report-db.js'
import { overspeedLimitFor } from '../../lib/derived-alerts.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { speedPolicyFor, warmSpeedPolicy, type SpeedPolicy } from '../../lib/speed-policy.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import { vehicleHeading } from './tat-fuel-report.service.js'

/** Reads running at once, each on a session of its own: Wialon serialises a session's requests. */
const SESSIONS = 5
const PAGE = 20_000
const SETTINGS_BATCH = 200
/** Our rows are thinned, so they can read a peak low by this much; a unit further under its limit is not read from Wialon. */
const THINNED_PEAK_KMH = 20
/** Gaps longer than this are not driven across, in the mileage. */
const MAX_GAP_S = 600
/** A hop faster than this is the fix jumping. */
const MAX_HOP_KMH = 180
const CACHE_MS = 60 * 60_000

/** One position: t in seconds. */
export interface SpeedMessage { t: number; lat: number | null; lng: number | null; kmh: number }

export interface Speeding {
  occurrences: number
  maxKmh: number
  overKm: number
  peak: { lat: number; lng: number; at: number } | null
}

export interface SpeedRow {
  vehicleId: string
  name: string
  plate: string
  group: string
  km: number
  maxKmh: number
  limitKmh: number
  overByKmh: number
  overKm: number
  occurrences: number
  peak: { lat: number; lng: number; at: number } | null
  source: 'wialon' | 'telemetry'
}

export interface SpeedReport {
  day: string
  rows: SpeedRow[]
  /** Units moving that day that were read. */
  read: number
  /** Wialon units that could not be read there and came from our telemetry. */
  fromTelemetry: number
  failed: number
}

function hopKm(a: SpeedMessage, b: SpeedMessage): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

/** The runs over the limit, in time order. Pure. */
export function speedingOf(messages: SpeedMessage[], limitKmh: number): Speeding {
  const out: Speeding = { occurrences: 0, maxKmh: 0, overKm: 0, peak: null }
  let run: SpeedMessage[] = []
  const close = () => {
    if (run.length >= 2 && run.at(-1)!.t > run[0]!.t) {
      out.occurrences += 1
      for (let i = 1; i < run.length; i++) out.overKm += hopKm(run[i - 1]!, run[i]!) ?? 0
      for (const m of run) {
        if (m.kmh <= out.maxKmh) continue
        out.maxKmh = m.kmh
        out.peak = m.lat == null || m.lng == null ? null : { lat: m.lat, lng: m.lng, at: m.t * 1000 }
      }
    }
    run = []
  }
  for (const m of messages) {
    if (m.kmh > limitKmh) run.push(m)
    else close()
  }
  close()
  return out
}

/** The distance driven: hops that moved, over a gap short enough to trust, at a speed a truck can do. Pure. */
export function mileageKm(messages: SpeedMessage[]): number {
  let km = 0
  for (let i = 1; i < messages.length; i++) {
    const a = messages[i - 1]!
    const b = messages[i]!
    const gap = b.t - a.t
    if (gap <= 0 || gap > MAX_GAP_S || (a.kmh < 1 && b.kmh < 1)) continue
    const d = hopKm(a, b)
    if (d != null && d / (gap / 3600) <= MAX_HOP_KMH) km += d
  }
  return km
}

/** The limit a unit is reported against. A Wialon limit of 0 is none set. Pure. */
export function limitFor(type: string, policy: SpeedPolicy | null, wialonKmh: number | null, fallbackKmh: number): number {
  const rule = policy?.byType?.[type.toUpperCase()]
  if (rule) return rule.outsideKmh
  return wialonKmh != null && wialonKmh > 0 ? wialonKmh : fallbackKmh
}

/** The heading a unit goes under: its type, and an untyped unit on a road plate is a truck (not a KTCC tractor, not a Landcruiser). Pure. */
export const groupOf = (v: { type: string; plate: string; name: string }): string => vehicleHeading(v)

/** Trucks first, then by heading; within one, by the unit's name, as the sheet is. Pure. */
export function sortSpeedRows<T extends Pick<SpeedRow, 'group' | 'name'>>(rows: T[]): T[] {
  const rank = (g: string) => (g === 'Trucks' ? 0 : 1)
  return [...rows].sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
}

/** "wialon:12345" -> 12345; any other device is not on Wialon. Pure. */
export function wialonIdOf(deviceId: string): number | null {
  const m = /^wialon:(\d+)$/.exec(deviceId)
  return m ? Number(m[1]) : null
}

/** Each [id, limit] set on the Wialon units; a unit that cannot be read is left out. */
async function wialonLimits(client: WialonClient, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  for (let i = 0; i < ids.length; i += SETTINGS_BATCH) {
    const part = ids.slice(i, i + SETTINGS_BATCH)
    const res = await client.call<Array<{ speedLimit?: number; error?: number }>>('core/batch', {
      params: part.map(itemId => ({ svc: 'unit/get_report_settings', params: { itemId } })), flags: 0,
    })
    res.forEach((r, n) => { if (typeof r?.speedLimit === 'number') out.set(part[n]!, r.speedLimit) })
  }
  return out
}

interface RawMessage { t?: number; pos?: { y?: number; x?: number; s?: number } | null }

/** A unit's day of messages off one session. */
async function readWialon(client: WialonClient, itemId: number, from: number, to: number): Promise<SpeedMessage[]> {
  const loaded = await client.call<{ count?: number }>('messages/load_interval', {
    // flags 1 / mask 0xFF01: data messages with a position, no SMS or events.
    itemId, timeFrom: from, timeTo: to, flags: 1, flagsMask: 0xFF01, loadCount: 0,
  })
  const total = loaded.count ?? 0
  const out: SpeedMessage[] = []
  for (let i = 0; i < total; i += PAGE) {
    const page = await client.call<Record<string, RawMessage> | RawMessage[]>('messages/get_messages', {
      indexFrom: i, indexTo: Math.min(i + PAGE, total) - 1,
    })
    for (const m of Array.isArray(page) ? page : Object.values(page)) {
      if (typeof m.t === 'number' && m.pos) out.push({ t: m.t, lat: m.pos.y ?? null, lng: m.pos.x ?? null, kmh: m.pos.s ?? 0 })
    }
  }
  await client.call('messages/unload', {}).catch(() => { /* best effort */ })
  return out.sort((a, b) => a.t - b.t)
}

async function readTelemetry(vehicleId: string, from: Date, to: Date): Promise<SpeedMessage[]> {
  const rows = await reportDb().$queryRaw<Array<{ captured_at: Date; lat: number | null; lng: number | null; speed_kmh: number | null }>>`
      SELECT captured_at, lat, lng, speed_kmh
        FROM vehicle_telemetries
       WHERE vehicle_id = ${vehicleId} AND captured_at >= ${from} AND captured_at < ${to}
       ORDER BY captured_at ASC`
  return rows.map(r => ({ t: r.captured_at.getTime() / 1000, lat: r.lat, lng: r.lng, kmh: r.speed_kmh ?? 0 }))
}

async function buildReport(orgId: string, day: string, allowed: Set<string> | null): Promise<SpeedReport> {
  const bounds = fleetDayBounds(day)
  if (!bounds) return { day, rows: [], read: 0, fromTelemetry: 0, failed: 0 }
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true },
    select: { id: true, name: true, registrationPlate: true, vehicleType: true, deviceId: true },
  })
  const units = vehicles.filter(v => !allowed || allowed.has(v.id))
  const fastest = new Map((await reportDb().$queryRaw<Array<{ vehicle_id: string; fastest: number | null }>>`
      SELECT vehicle_id, max(speed_kmh) AS fastest
        FROM vehicle_telemetries
       WHERE captured_at >= ${bounds.from} AND captured_at < ${bounds.to} AND vehicle_id = ANY(${units.map(u => u.id)})
       GROUP BY vehicle_id`).map(r => [r.vehicle_id, r.fastest ?? 0]))

  await warmSpeedPolicy(orgId)
  const policy = speedPolicyFor(orgId)
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const sessions = Array.from({ length: SESSIONS }, () => new WialonClient(token, env.WIALON_API_URL))
  const onWialon = units.flatMap((u) => { const id = wialonIdOf(u.deviceId); return id == null ? [] : [id] })
  const limits = await wialonLimits(sessions[0]!, onWialon).catch((err: unknown) => {
    logger.warn({ err, orgId }, 'Speed report: limits could not be read from Wialon')
    return new Map<number, number>()
  })

  const fromSec = Math.floor(bounds.from.getTime() / 1000)
  const toSec = Math.floor(bounds.to.getTime() / 1000) - 1
  const planned = units.flatMap((u) => {
    const wialonId = wialonIdOf(u.deviceId)
    const limitKmh = limitFor(u.vehicleType, policy, wialonId == null ? null : limits.get(wialonId) ?? null, overspeedLimitFor(u.vehicleType))
    const seen = fastest.get(u.id)
    // No rows of ours says nothing about Wialon, so it is read there all the same.
    const worth = wialonId != null
      ? seen == null || seen > limitKmh - THINNED_PEAK_KMH
      : seen != null && seen > limitKmh
    return worth ? [{ unit: u, wialonId, limitKmh }] : []
  })

  const rows: SpeedRow[] = []
  let fromTelemetry = 0
  let failed = 0
  let next = 0
  const work = async (client: WialonClient) => {
    while (next < planned.length) {
      const { unit, wialonId, limitKmh } = planned[next++]!
      try {
        let source: SpeedRow['source'] = 'telemetry'
        let messages: SpeedMessage[] | null = null
        if (wialonId != null) {
          try {
            messages = await readWialon(client, wialonId, fromSec, toSec)
            source = 'wialon'
          } catch (err) {
            logger.warn({ err, vehicleId: unit.id }, 'Speed report: Wialon messages could not be read; using our telemetry')
            fromTelemetry += 1
          }
        }
        messages ??= await readTelemetry(unit.id, bounds.from, bounds.to)
        const s = speedingOf(messages, limitKmh)
        if (!s.occurrences) continue
        const plate = unit.registrationPlate
        rows.push({
          vehicleId: unit.id, name: unit.name.replace(/\s+/g, ' ').trim(), plate, group: groupOf({ type: unit.vehicleType, plate, name: unit.name }),
          km: Math.round(mileageKm(messages) * 100) / 100, maxKmh: s.maxKmh, limitKmh, overByKmh: s.maxKmh - limitKmh,
          overKm: Math.round(s.overKm * 100) / 100, occurrences: s.occurrences, peak: s.peak, source,
        })
      } catch (err) {
        logger.warn({ err, vehicleId: unit.id }, 'Speed report: unit could not be read')
        failed += 1
      }
    }
  }
  try {
    await Promise.all(sessions.map(work))
  } finally {
    await Promise.all(sessions.map(c => c.logout().catch(() => { /* best effort */ })))
  }
  return { day, rows: sortSpeedRows(rows), read: planned.length, fromTelemetry, failed }
}

const made = new Map<string, { at: number; report: Promise<SpeedReport> }>()

/** A closed day barely changes and takes a while to read, so it is kept for a while. */
export async function getSpeedReport(orgId: string, day: string, allowed: Set<string> | null = null, now = Date.now()): Promise<SpeedReport> {
  const closed = (fleetDayBounds(day)?.to.getTime() ?? now) <= now
  if (!closed || allowed) return buildReport(orgId, day, allowed)
  const key = `${orgId}|${day}`
  const held = made.get(key)
  if (held && now - held.at < CACHE_MS) return held.report
  for (const [k, v] of made) if (now - v.at >= CACHE_MS) made.delete(k)
  const report = buildReport(orgId, day, null)
  made.set(key, { at: now, report })
  report.catch(() => made.delete(key))
  return report
}
