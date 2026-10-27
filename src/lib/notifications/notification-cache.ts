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
 * ## Why the member is the feedId and not the payload
 *
 * A ZSET member is unique by VALUE. Storing `JSON.stringify(item)` therefore
 * made the identity of a notification its exact serialised body, not its
 * `feedId` — so a redelivery whose wording had drifted by one character became
 * a SECOND member at the same score, and the cached page showed one event
 * twice while Postgres (which upserts on `feedId`) held a single clean row.
 * Fuel is exactly where that bites: Wialon refines a filling's volume, final
 * level and location as settled readings arrive, so a republished event is
 * routinely almost-but-not-quite identical.
 *
 * The ZSET now holds ids and a companion hash holds the payloads, which makes
 * `feedId` the identity here too. Keeping the two in step needs one atomic
 * step — see TRIM_SCRIPT.
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
  /** Who did it, when a person did. */
  actorId?:   string | null
  orgId?:     string
  /** Emitter extras with no Postgres column (feed-events' lat/lng). */
  [k: string]: unknown
}

/** ZSET of feedIds, scored by event time. */
const key = (orgId: string) => `notif:feed:${orgId}`
/** HASH of feedId → serialised item, in step with the ZSET above. */
const dataKey = (orgId: string) => `notif:data:${orgId}`

/** Trim to NOTIFICATION_CACHE_MAX newest AND drop anything past retention. */
const retentionMs = () => env.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60_000

/**
 * Add one item and re-apply both bounds, atomically.
 *
 * Lua because the index and the payloads are now two keys: a trim that removed
 * ids from the ZSET without removing the matching hash fields would leak a
 * payload per evicted notification forever, and doing it as two round trips
 * would leave that window open on every write. One script, one round trip, no
 * interleaving.
 *
 * `ZREM`/`HDEL` per victim rather than `unpack(victims)`: the steady state is
 * zero or one victim per call, and a bulk `unpack` of a large table is what
 * blows the Lua stack on the one-off case that matters — an operator lowering
 * NOTIFICATION_CACHE_MAX, where the first write after the change evicts
 * thousands at once.
 */
export const TRIM_SCRIPT = `
local z, h = KEYS[1], KEYS[2]
local score, id, payload = ARGV[1], ARGV[2], ARGV[3]
local max, cutoff, ttl   = tonumber(ARGV[4]), ARGV[5], tonumber(ARGV[6])

redis.call('ZADD', z, score, id)
redis.call('HSET', h, id, payload)

-- Bound by count: rank 0 is the OLDEST in a ZSET, so ranks 0..-(max+1) are
-- everything below the newest max.
local victims = redis.call('ZRANGE', z, 0, -(max + 1))
-- Bound by age: the same window the retention sweep enforces in Postgres, so
-- the cache can never serve something the store has already deleted.
for _, v in ipairs(redis.call('ZRANGEBYSCORE', z, '-inf', cutoff)) do
  victims[#victims + 1] = v
end

for _, v in ipairs(victims) do
  redis.call('ZREM', z, v)
  redis.call('HDEL', h, v)
end

-- Belt and braces: an org that goes quiet forever should not pin memory.
redis.call('EXPIRE', z, ttl)
redis.call('EXPIRE', h, ttl)
return #victims
`

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

  const ttl = Math.ceil(retentionMs() / 1000)

  try {
    await redis.eval(
      TRIM_SCRIPT, 2, key(orgId), dataKey(orgId),
      String(score), item.id, JSON.stringify(item),
      String(env.NOTIFICATION_CACHE_MAX), String(Date.now() - retentionMs()), String(ttl),
    )
    warnedWriteFailure = false
  } catch (err) {
    // A transient failure here is genuinely uninteresting — the feed is
    // unaffected and the next notification retries. A PERSISTENT one is not:
    // a script that can never run means the cache silently stops being
    // written, every read falls through to Postgres, and nothing says so.
    // Debug-level logging would hide exactly that, so the first failure of a
    // run is a warning and the repeats are not.
    if (!warnedWriteFailure) {
      warnedWriteFailure = true
      logger.warn({ err, orgId }, 'Notification cache write failed — feed is unaffected, reads fall back to Postgres')
    } else {
      logger.debug({ err, orgId }, 'Notification cache write failed — feed is unaffected')
    }
  }
}

/** One warning per outage, not one per notification. */
let warnedWriteFailure = false

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
    const members = await redis.zrevrange(key(orgId), 0, limit - 1)
    if (members.length === 0) return null

    // A member written before this key held ids is the payload itself. Deploying
    // over a warm cache would otherwise blank every org's first page until the
    // ZSET churned through, which for a quiet org is days. Mixed sets read fine
    // and the legacy members age out on their own.
    const legacy = new Map<number, NotificationItem>()
    const ids: string[] = []
    members.forEach((m, i) => {
      if (m.startsWith('{')) {
        try { legacy.set(i, JSON.parse(m) as NotificationItem); return } catch { /* fall through */ }
      }
      ids.push(m)
    })

    const payloads = ids.length > 0 ? await redis.hmget(dataKey(orgId), ...ids) : []
    let next = 0

    return members.flatMap((_, i) => {
      const fromLegacy = legacy.get(i)
      if (fromLegacy) return [fromLegacy]
      const raw = payloads[next++]
      // A missing hash field means the two keys drifted — possible only if the
      // hash was evicted independently. Skip it rather than serve a hole.
      if (!raw) return []
      try { return [JSON.parse(raw) as NotificationItem] } catch { return [] }
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

  const ttl = Math.ceil(retentionMs() / 1000)

  try {
    // Both keys are replaced together — priming the index while leaving stale
    // payloads behind would keep evicted notifications alive in the hash.
    const pipeline = redis.multi().del(key(orgId)).del(dataKey(orgId))
    for (const item of items) {
      const score = Date.parse(item.ts)
      if (!Number.isFinite(score)) continue
      pipeline.zadd(key(orgId), score, item.id)
      pipeline.hset(dataKey(orgId), item.id, JSON.stringify(item))
    }
    await pipeline.expire(key(orgId), ttl).expire(dataKey(orgId), ttl).exec()
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
      for (const k of keys) {
        const orgId = k.slice('notif:feed:'.length)
        // Read the victims before removing them, so their payloads go too. A
        // ZREMRANGEBYSCORE on its own would strand one hash field per swept
        // notification — 90 days of them, on the box's tightest resource.
        const victims = await redis.zrangebyscore(k, '-inf', cutoff)
        if (victims.length === 0) continue
        const removed = await redis.zremrangebyscore(k, '-inf', cutoff)
        // Legacy members are the payload, not an id; there is no hash field to
        // drop for those.
        const ids = victims.filter((v) => !v.startsWith('{'))
        if (ids.length > 0) await redis.hdel(dataKey(orgId), ...ids)
        trimmed += removed
      }
    } while (cursor !== '0')
  } catch (err) {
    logger.warn({ err }, 'Notification cache trim failed')
  }
  return trimmed
}

// ── One vehicle, one fleet day ──────────────────────────────────────────────
//
// A SECOND cache with a different shape, because the org feed's shape cannot
// answer this question. That one is capped at NOTIFICATION_CACHE_MAX and mixed
// across every unit and type, so a per-vehicle read served from it would omit
// exactly the matches it had evicted — which is why `getNotifications` sends
// every filtered read straight to Postgres.
//
// A vehicle-day is different in the one way that matters: it is COMPLETE. The
// whole set fits (the busiest measured vehicle-day carried 154 notifications),
// and once the day is over the answer can never change. That is what makes it
// cacheable without lying, and it is the read an operator makes over and over
// while working through a unit's history.

const dayKey = (vehicleId: string, day: string) => `notif:v:${vehicleId}:${day}`

/**
 * A completed vehicle-day, or null for "ask Postgres".
 *
 * Null rather than [] on a miss, an error or no Redis — [] is a claim that the
 * unit did nothing that day, which is a real and different answer.
 */
export async function readCachedVehicleDay(
  vehicleId: string, day: string,
): Promise<NotificationItem[] | null> {
  const redis = getCacheRedis()
  if (!redis) return null
  try {
    const raw = await redis.get(dayKey(vehicleId, day))
    if (raw == null) return null
    const parsed = JSON.parse(raw) as NotificationItem[]
    return Array.isArray(parsed) ? parsed : null
  } catch (err) {
    logger.debug({ err, vehicleId, day }, 'Vehicle-day cache read failed — falling back to Postgres')
    return null
  }
}

/**
 * Store a completed vehicle-day, including an EMPTY one.
 *
 * A unit that reported nothing on a given day is the most common answer of all
 * and the most wasteful to re-derive: without caching the empty case, every
 * quiet day an operator scrolls past is a fresh index scan. `[]` is a fact
 * about a finished day, not an absence of information — which is exactly why
 * the read above distinguishes null from [].
 *
 * TTL is what remains of the retention window for that day, so a cached day
 * cannot outlive the Postgres rows behind it and start answering for history
 * the sweep has already deleted.
 */
export async function cacheVehicleDay(
  vehicleId: string, day: string, items: NotificationItem[], dayStartMs: number,
): Promise<void> {
  const redis = getCacheRedis()
  if (!redis) return
  const ttlMs = dayStartMs + retentionMs() - Date.now()
  if (ttlMs <= 0) return
  try {
    await redis.set(dayKey(vehicleId, day), JSON.stringify(items), 'EX', Math.ceil(ttlMs / 1000))
  } catch (err) {
    logger.debug({ err, vehicleId, day }, 'Vehicle-day cache write failed')
  }
}
