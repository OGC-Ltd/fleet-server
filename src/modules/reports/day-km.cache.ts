/**
 * Each unit-day's distance evidence (DayKmEvidence: the GPS sum, the odometer's
 * count, how many fixes and readings), cached for 7 days (operator, 18 Nov 2026:
 * "cache the odometer data for easier query instead of querying the db each
 * time ... expires after 7 days").
 *
 * Keyed by vehicle and fleet day, not by organisation or request, so the Fuel
 * Consumption Rate report and Weighbridges › Coverage share one entry. Only a
 * settled day is cached: a day still open, or one that ended under SETTLE_MS
 * ago, still gains rows. A Wialon fill (unit-distance) writes its result over
 * the entry, so the next read has the filled figure.
 *
 * Redis (db 0, the evictable cache) when it is up, so every process and every
 * restart share it; the process's own memory, bounded, when it is not. A Redis
 * error costs a database read, never a failed request.
 */

import { getCacheRedis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'
import type { DayKmEvidence } from './range-reports.service.js'

export const DAY_KM_TTL_S = 7 * 86_400
/** A day is settled this long after it ends: late rows have arrived by then. */
export const SETTLE_MS = 6 * 3_600_000
const LOCAL_MAX = 50_000

export const dayKmKey = (vehicleId: string, day: string) => `odo:daykm:v1:${vehicleId}:${day}`

const local = new Map<string, { e: DayKmEvidence; until: number }>()

const isEvidence = (v: unknown): v is DayKmEvidence =>
  !!v && typeof v === 'object'
  && ['gpsKm', 'odoKm', 'odoReadings', 'fixes'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number')

/** The cached evidence for these units on this day; a unit missing from the map is a miss. */
export async function readDayKm(vehicleIds: string[], day: string, now = Date.now()): Promise<Map<string, DayKmEvidence>> {
  const out = new Map<string, DayKmEvidence>()
  if (!vehicleIds.length) return out
  const redis = getCacheRedis()
  if (redis) {
    try {
      const raws = await redis.mget(...vehicleIds.map((id) => dayKmKey(id, day)))
      raws.forEach((raw, i) => {
        if (raw == null) return
        const e: unknown = JSON.parse(raw)
        if (isEvidence(e)) out.set(vehicleIds[i]!, e)
      })
      return out
    } catch (err) {
      logger.warn({ err, day }, 'Day distance cache read failed, reading the database')
    }
  }
  for (const id of vehicleIds) {
    const hit = local.get(dayKmKey(id, day))
    if (hit && hit.until > now) out.set(id, hit.e)
  }
  return out
}

/** Keeps these units' evidence for the day for DAY_KM_TTL_S. A failure only costs a later database read. */
export async function keepDayKm(entries: [string, DayKmEvidence][], day: string, now = Date.now()): Promise<void> {
  if (!entries.length) return
  const redis = getCacheRedis()
  if (redis) {
    try {
      const pipe = redis.pipeline()
      for (const [id, e] of entries) pipe.set(dayKmKey(id, day), JSON.stringify(e), 'EX', DAY_KM_TTL_S)
      await pipe.exec()
      return
    } catch (err) {
      logger.warn({ err, day }, 'Day distance cache write failed')
    }
  }
  for (const [id, e] of entries) {
    const key = dayKmKey(id, day)
    local.delete(key)
    if (local.size >= LOCAL_MAX) local.delete(local.keys().next().value!)
    local.set(key, { e, until: now + DAY_KM_TTL_S * 1000 })
  }
}

/** Tests only. */
export function _clearDayKmCache() { local.clear() }
