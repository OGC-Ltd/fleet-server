/**
 * Redis in front of the Deliveries report's day lists and typed orders
 * (operator, 11 Nov 2026: "we persist and cache, then from there we query the
 * cache").
 *
 * Read-through: a read asks Redis first and, on a miss, Postgres, then keeps
 * what it found. Write-through: every save goes to Postgres FIRST, then the
 * saved value replaces the cached one, so the next reader (any API process,
 * any browser) gets it from Redis at once, with no window where the cache
 * still holds the old list.
 *
 * It is a cache, not a store. No Redis (REDIS_URL unset, or the client not
 * ready) or a Redis error costs a Postgres read, never a failed request.
 */

import { getCacheRedis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'

/** A day's list is edited through the day and read for a few days after. */
export const DAY_TTL_S = 3 * 86_400
/** The typed orders change rarely and are read on every report. */
export const ORDERS_TTL_S = 86_400

export const dayKey = (orgId: string, day: string) => `dlv:day:${orgId}:${day}`
export const ordersKey = (orgId: string) => `dlv:orders:${orgId}`

/**
 * ## Every entry carries the moment its Postgres read began
 *
 * Two writers can finish in Postgres in one order and reach Redis in the other,
 * and a reader that loaded the old row just before a save can put it back after
 * the save cached the new one. Either way Redis would serve an older list than
 * Postgres holds, for days. So each entry is stored as `{ s, v }`, where `s` is
 * when the Postgres read that produced `v` STARTED (a writer: after its write
 * returned), and KEEP_SCRIPT replaces an entry only with one whose `s` is not
 * older. A read that began before a write can never overwrite that write.
 */
type Entry<T> = { s: number; v: T }

const KEEP_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, e = pcall(cjson.decode, cur)
  if ok and type(e) == 'table' and tonumber(e.s) and tonumber(e.s) > tonumber(ARGV[2]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1`

/** The cached value, or undefined on a miss, no Redis, or a Redis error. */
async function peek<T>(key: string): Promise<T | undefined> {
  const redis = getCacheRedis()
  if (!redis) return undefined
  try {
    const raw = await redis.get(key)
    if (raw == null) return undefined
    const e = JSON.parse(raw) as Entry<T>
    return e && typeof e === 'object' && 's' in e ? e.v : undefined
  } catch (err) {
    logger.warn({ err, key }, 'Deliveries cache read failed, reading Postgres')
    return undefined
  }
}

/**
 * Keep a value read from Postgres at `stamp` (ms), unless the cache already
 * holds one read later. A failure only means the next read goes to Postgres.
 */
export async function keep(key: string, value: unknown, ttlS: number, stamp: number): Promise<void> {
  const redis = getCacheRedis()
  if (!redis) return
  try {
    await redis.eval(KEEP_SCRIPT, 1, key, JSON.stringify({ s: stamp, v: value }), String(stamp), String(ttlS))
  } catch (err) {
    // A stale entry would outlive the write, so drop it rather than leave it
    logger.warn({ err, key }, 'Deliveries cache write failed, dropping the entry')
    await redis.del(key).catch(() => undefined)
  }
}

/** Redis first; on a miss, `load` from Postgres and keep the result. */
export async function readThrough<T>(key: string, ttlS: number, load: () => Promise<T>): Promise<T> {
  const hit = await peek<T>(key)
  if (hit !== undefined) return hit
  const stamp = Date.now()
  const value = await load()
  await keep(key, value, ttlS, stamp)
  return value
}
