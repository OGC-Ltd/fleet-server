/**
 * Redis cache for notification history — a per-organisation sorted set scored
 * by event time.
 *
 * ## What it replaces
 *
 * The Live Feed used to be a 60-item array in lib/sse.ts that was GLOBAL
 * across organisations and died with the process. Two consequences: a restart
 * blanked the operations panel (patched over by replaying 40 rows from
 * Postgres at boot), and every org's dashboard saw every other org's activity.
 * This is per-org, survives restarts, and is bounded by both count and age.
 *
 * ## Why a ZSET and not a LIST
 *
 * Notifications do not arrive in event order. A reconcile pass surfaces alerts
 * the webhook missed, minutes or hours after the fact, and the provider's own
 * timestamps are offsetless local time. A LIST would interleave those into the
 * wrong place in the feed. Scoring by `occurredAt` means insertion order is
 * irrelevant — ZREVRANGEBYSCORE always returns a correctly ordered feed, and
 * trimming by age is ZREMRANGEBYSCORE rather than a scan.
 *
 * ## It is a cache, not a store
 *
 * Every write here is preceded by a Postgres write (see notification.store).
 * Losing Redis entirely costs a slower read that falls through to Postgres,
 * which is exactly what happens today while the box awaits its resize.
 */

import { getCacheRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'

/** Feed item as the dashboard consumes it (matches the SSE `feed` payload). */
export interface NotificationItem {
  id:         string
  time:       string
  ts:         string
  type:       string
  text:       string
  source:     string
  alertType?: string | null
  plate?:     string | null
  vehicleId?: string | null
  orgId?:     string
  /** Emitter extras with no Postgres column (feed-events' lat/lng). */
  [k: string]: unknown
}

const key = (orgId: string) => `notif:feed:${orgId}`

/** Trim to NOTIFICATION_CACHE_MAX newest AND drop anything past retention. */
const retentionMs = () => env.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60_000

/**
 * Add one notification to an org's cached feed.
 *
 * Never throws and never awaits anything the caller depends on: a cache write
 * failing must not stop the notification reaching the dashboard.
 */
export async function cacheNotification(orgId: string, item: NotificationItem): Promise<void> {
  const redis = getCacheRedis()
  if (!redis) return

  const score = Date.parse(item.ts)
  if (!Number.isFinite(score)) return

  try {
    await redis.multi()
      // Score by event time so out-of-order arrivals land in the right place.
      .zadd(key(orgId), score, JSON.stringify(item))
      // Bound by count: keep the newest N (rank 0 is the OLDEST in a ZSET, so
      // removing ranks 0..-(N+1) drops everything below the newest N).
      .zremrangebyrank(key(orgId), 0, -(env.NOTIFICATION_CACHE_MAX + 1))
      // Bound by age: same window the retention sweep enforces in Postgres, so
      // the cache can never serve something the store has already deleted.
      .zremrangebyscore(key(orgId), '-inf', Date.now() - retentionMs())
      // Belt and braces: an org that goes quiet forever should not pin memory.
      .expire(key(orgId), Math.ceil(retentionMs() / 1000))
      .exec()
  } catch (err) {
    logger.debug({ err, orgId }, 'Notification cache write failed — feed is unaffected')
  }
}

/**
 * Read an org's cached feed, newest first.
 *
 * Returns null (NOT an empty array) when the cache cannot answer — no Redis,
 * an error, or a cold key. The distinction matters: null means "ask Postgres",
 * whereas [] would be a claim that the org genuinely has no notifications.
 */
export async function readCachedNotifications(orgId: string, limit: number): Promise<NotificationItem[] | null> {
  const redis = getCacheRedis()
  if (!redis) return null

  try {
    const raw = await redis.zrevrange(key(orgId), 0, limit - 1)
    if (raw.length === 0) return null
    return raw.flatMap((s) => {
      try { return [JSON.parse(s) as NotificationItem] } catch { return [] }
    })
  } catch (err) {
    logger.debug({ err, orgId }, 'Notification cache read failed — falling back to Postgres')
    return null
  }
}

/**
 * Replace an org's cached feed wholesale. Used to warm the cache from Postgres
 * after a miss, so the next read is served hot.
 */
export async function primeCache(orgId: string, items: NotificationItem[]): Promise<void> {
  const redis = getCacheRedis()
  if (!redis || items.length === 0) return

  try {
    const pipeline = redis.multi().del(key(orgId))
    for (const item of items) {
      const score = Date.parse(item.ts)
      if (Number.isFinite(score)) pipeline.zadd(key(orgId), score, JSON.stringify(item))
    }
    await pipeline.expire(key(orgId), Math.ceil(retentionMs() / 1000)).exec()
  } catch (err) {
    logger.debug({ err, orgId }, 'Notification cache prime failed')
  }
}

/** Drop cached entries older than the retention window, across all orgs. */
export async function trimCachedNotifications(): Promise<number> {
  const redis = getCacheRedis()
  if (!redis) return 0

  // The sweep runs unattended at 03:17; if Redis happens to be down then, the
  // Postgres deletes still happened and the cache's own TTL/score bounds keep
  // it honest until the next run.
  const cutoff = Date.now() - retentionMs()
  let trimmed = 0
  try {
    // SCAN, not KEYS: KEYS blocks the whole server, and this runs on the same
    // instance serving live feed reads.
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'notif:feed:*', 'COUNT', 100)
      cursor = next
      for (const k of keys) trimmed += await redis.zremrangebyscore(k, '-inf', cutoff)
    } while (cursor !== '0')
  } catch (err) {
    logger.warn({ err }, 'Notification cache trim failed')
  }
  return trimmed
}
