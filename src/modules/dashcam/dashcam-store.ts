/**
 * Where the Alarms page and the reports read dashcam alarms from, once the
 * vss-worker has captured them (src/vss-worker.ts, lib/queues/vss-sync.ts).
 *
 *  · Redis, cache db: one gzipped blob per organisation per fleet day holding
 *    the whole day as getAlarms serves it, clips and photos included, kept
 *    VSS_CACHE_DAYS (30) after its last capture. VSS keeps its files about
 *    two weeks, so on older days the links answer "deleted".
 *  · Redis: each clip/photo link key → the real VSS address, so the API
 *    process can stream a file the worker listed (file keys used to live only
 *    in the memory of the process that searched).
 *  · Postgres (dashcam_alarms): the numbers of every captured day, for good:
 *    the fallback for a day the cache does not hold. No media. What it
 *    answers is written back into the cache (only where the key is empty, so
 *    the worker's copy with media is never replaced by it).
 *  · Redis: each organisation's vehicles with a paired camera, so readers
 *    count cameras without asking VSS for its device list.
 *
 * Nothing here throws: a Redis or database problem reads as "not held", and
 * the caller falls back to the next source.
 */

import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { prisma } from '../../lib/prisma.js'
import { getCacheRedis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import type { DashcamIncident } from './dashcam.service.js'
import { vssEvent, vssCategory } from './vss-events.js'
import { DAY, dayWindow, fleetDayOf } from './fleet-day.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

const dayKey = (orgId: string, day: string) => `vss:alarms:v1:${orgId}:${day}`
const fileKey = (k: string) => `vss:file:v1:${k}`
const camerasKey = (orgId: string) => `vss:cameras:v1:${orgId}`
/** VSS deletes its files after about two weeks; a link key past that has nothing to stream. */
const FILE_TTL_S = 15 * 86_400

/** One organisation's fleet day, as captured. */
export interface StoredDay {
  cameras: number
  incidents: DashcamIncident[]
  partial: boolean
  /** The capture covered the day up to here (ms): today's ends at the capture's own time. */
  through: number
  /** When it was captured (ms). */
  cachedAt: number
  /** 'db': written back from dashcam_alarms by a reader, without clips or photos. */
  source?: 'vss' | 'db'
}

/** A captured day as the database holds it. */
export interface DbDay {
  incidents: DashcamIncident[]
  partial: boolean
  /** When the worker last captured it (ms). */
  capturedAt: number
}

// Parsed blobs, briefly: the rail badge and the page poll the same day over and over.
const MEMO_MAX = 64
const MEMO_TODAY_MS = 30_000
const MEMO_PAST_MS = 10 * 60_000
const memo = new Map<string, { at: number; value: StoredDay }>()

/**
 * Cache one day. False when Redis is not there (the database still has the
 * numbers), or, with `onlyIfAbsent`, when the key is already held.
 */
export async function storeDay(orgId: string, day: string, value: StoredDay, { onlyIfAbsent = false } = {}): Promise<boolean> {
  const redis = getCacheRedis()
  if (!redis) return false
  try {
    const buf = await gzip(Buffer.from(JSON.stringify(value)))
    const ttl = env.VSS_CACHE_DAYS * 86_400
    const ok = onlyIfAbsent
      ? await redis.set(dayKey(orgId, day), buf, 'EX', ttl, 'NX')
      : await redis.set(dayKey(orgId, day), buf, 'EX', ttl)
    if (ok !== 'OK') return false
    memo.delete(dayKey(orgId, day))
    return true
  } catch (err) {
    logger.warn({ err, orgId, day }, 'dashcam store: day not cached')
    return false
  }
}

/** The days the cache holds, of those asked for. */
export async function readDays(orgId: string, days: string[], now = Date.now()): Promise<Map<string, StoredDay>> {
  const out = new Map<string, StoredDay>()
  if (!days.length) return out
  const today = fleetDayOf(now)
  const want: string[] = []
  for (const d of days) {
    const hit = memo.get(dayKey(orgId, d))
    if (hit && now - hit.at < (d === today ? MEMO_TODAY_MS : MEMO_PAST_MS)) out.set(d, hit.value)
    else want.push(d)
  }
  const redis = getCacheRedis()
  if (!redis || !want.length) return out
  try {
    const bufs = await redis.mgetBuffer(...want.map((d) => dayKey(orgId, d)))
    await Promise.all(want.map(async (d, i) => {
      const buf = bufs[i]
      if (!buf) return
      try {
        const value = JSON.parse((await gunzip(buf)).toString('utf8')) as StoredDay
        out.set(d, value)
        memo.set(dayKey(orgId, d), { at: now, value })
      } catch (err) {
        logger.warn({ err, orgId, day: d }, 'dashcam store: cached day unreadable — read elsewhere')
      }
    }))
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string)
  } catch (err) {
    logger.warn({ err, orgId }, 'dashcam store: cache unreachable — reading the database')
  }
  return out
}

/** The vehicles of an organisation with a paired camera (the worker writes it each sync). */
export async function storeCameras(orgId: string, vehicleIds: string[]): Promise<void> {
  const redis = getCacheRedis()
  if (!redis) return
  try {
    await redis.set(camerasKey(orgId), JSON.stringify(vehicleIds), 'EX', env.VSS_CACHE_DAYS * 86_400)
  } catch (err) {
    logger.warn({ err, orgId }, 'dashcam store: cameras not cached')
  }
}

/** Those vehicles, or null when the worker has not written them. */
export async function readCameras(orgId: string): Promise<string[] | null> {
  const redis = getCacheRedis()
  if (!redis) return null
  try {
    const raw = await redis.get(camerasKey(orgId))
    const v = raw ? JSON.parse(raw) : null
    return Array.isArray(v) ? v.map(String) : null
  } catch {
    return null
  }
}

/** Keep a clip or photo's real address where every process can find it. */
export function rememberFile(k: string, orgId: string, url: string): void {
  const redis = getCacheRedis()
  if (!redis) return
  redis.set(fileKey(k), JSON.stringify({ o: orgId, u: url }), 'EX', FILE_TTL_S)
    .catch((err: unknown) => logger.debug({ err }, 'dashcam store: file link not cached'))
}

/** A link key's VSS address, if another process listed it. */
export async function storedFile(k: string): Promise<{ orgId: string; url: string } | null> {
  const redis = getCacheRedis()
  if (!redis) return null
  try {
    const raw = await redis.get(fileKey(k))
    if (!raw) return null
    const v = JSON.parse(raw) as { o?: string; u?: string }
    return v.o && v.u ? { orgId: v.o, url: v.u } : null
  } catch {
    return null
  }
}

/**
 * The days the database holds (captured at least once), with their alarms.
 * No clips or photos: those were only ever in VSS.
 */
export async function dbDays(orgId: string, days: string[]): Promise<Map<string, DbDay>> {
  const out = new Map<string, DbDay>()
  if (!days.length) return out
  try {
    const held = await prisma.dashcamCaptureDay.findMany({
      where: { organisationId: orgId, day: { in: days } },
      select: { day: true, partial: true, capturedAt: true },
    })
    if (!held.length) return out
    const heldDays = held.map((h) => h.day).sort()
    for (const h of held) out.set(h.day, { incidents: [], partial: h.partial, capturedAt: h.capturedAt.getTime() })
    const rows = await prisma.dashcamAlarm.findMany({
      where: {
        organisationId: orgId,
        occurredAt: { gte: new Date(dayWindow(heldDays[0]!).from), lt: new Date(dayWindow(heldDays.at(-1)!).to) },
      },
      orderBy: { occurredAt: 'desc' },
      take: 200_000,
    })
    for (const r of rows) {
      const list = out.get(fleetDayOf(r.occurredAt.getTime()))?.incidents
      if (!list) continue      // a day between two held ones that was never captured
      // An alarm held without its type reads as the live answer would give it: "Unknown".
      const ev = vssEvent(r.code)
      list.push({
        id: r.id,
        code: r.code,
        label: r.label || ev.name,
        group: r.group || ev.group,
        severity: (r.severity || (ev.severity === 'info' ? 'informational' : ev.severity)) as DashcamIncident['severity'],
        category: (r.category || vssCategory(r.code)) as DashcamIncident['category'],
        occurredAt: r.occurredAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        vehicleId: r.vehicleId ?? '',
        plate: r.plate,
        deviceId: r.deviceId,
        lat: r.lat,
        lng: r.lng,
        speed: r.speedKmh,
        videos: [],
        photos: [],
      })
    }
  } catch (err) {
    logger.warn({ err, orgId }, 'dashcam store: database days unreadable')
    return new Map()
  }
  return out
}

/** For tests. */
export function resetStoreMemo(): void { memo.clear() }

export { DAY }
