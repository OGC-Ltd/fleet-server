/**
 * A rate-limit counter that survives being spread across processes.
 *
 * express-rate-limit's default MemoryStore keeps the count in the node process,
 * so "100 per second" silently means "100 per second PER PROCESS". That is
 * exact today — pm2 runs one `server` in fork mode — but it is a property of
 * the deployment, not of the code, and nothing tells you when it stops being
 * true. Whoever runs `pm2 scale server 4`, or puts a second box behind a load
 * balancer, gets a 400/s limit and no error.
 *
 * It matters most where it looks least dramatic. `authLimiter` is twenty
 * sign-in attempts per fifteen minutes, and it is the only thing between an
 * exposed login endpoint and an offline-speed password guess. Four processes
 * quietly make it eighty, and the `RateLimit` response headers keep reporting a
 * perfectly plausible remaining count from whichever bucket answered.
 *
 * So the counter goes to the Redis the app already runs.
 *
 * ## Falling back, not falling over
 *
 * Redis here is OPTIONAL by design — `getCacheRedis()` returns null when it is
 * unconfigured, still connecting, or down, and every other caller in this
 * codebase treats those three identically by degrading rather than failing
 * (lib/notifications/notification-cache, lib/authz/subject). This follows that
 * convention: a Redis blip must not 500 every request on the platform, and must
 * not admit everything either. It falls back to an in-memory count, which is
 * exactly the behaviour we have today.
 *
 * The client is resolved PER COMMAND rather than captured once. It has to be:
 * the store is constructed at module load, the connection is `lazyConnect` and
 * takes seconds to become ready, and `enableOfflineQueue: false` makes ioredis
 * THROW on a command issued before then rather than queue it.
 *
 * ## TTLs are not optional
 *
 * Cache DB 0 runs `maxmemory-policy volatile-lru`, which only evicts keys that
 * carry a TTL. A rate-limit key without one would be permanently resident and
 * would compete with BullMQ for the same maxmemory — the queue DB is
 * deliberately `noeviction` because an evicted job is work silently never done.
 * rate-limit-redis sets a TTL on every key it writes, which is what makes it
 * safe to put here; do not "optimise" that away.
 *
 * An evicted key resets one window early. That fails open for a fraction of a
 * second, which is the right direction for a capacity limiter.
 */

import { MemoryStore } from 'express-rate-limit'
import type { Store, Options, ClientRateLimitInfo, IncrementResponse } from 'express-rate-limit'
import RedisStore from 'rate-limit-redis'
import { getCacheRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

/**
 * One line per outage, not per request.
 *
 * A Redis outage means every request takes the fallback path, and at 100/s an
 * unguarded log would bury the reason for the outage under the symptom.
 */
let degraded = false

function noteDegraded(err: unknown, prefix: string): void {
  if (degraded) return
  degraded = true
  logger.warn({ err, prefix }, 'rate limit: Redis unavailable — counting in memory until it returns')
}

function noteRecovered(prefix: string): void {
  if (!degraded) return
  degraded = false
  logger.info({ prefix }, 'rate limit: Redis back — counting shared again')
}

/**
 * @param prefix  Namespaces one limiter's keys. Each limiter gets its own so
 *   their windows stay independent, and all of them start `rl:` so they cannot
 *   collide with the notification cache's `notif:*` keys in the same database.
 */
export function createRateLimitStore(prefix: string): Store {
  const redisStore = new RedisStore({
    prefix,
    // Resolved per command, never captured — see the note above.
    sendCommand: (...args: string[]) => {
      const client = getCacheRedis()
      if (!client) throw new Error('redis unavailable')
      return client.call(args[0]!, ...args.slice(1)) as Promise<never>
    },
  })

  // The same store MemoryStore would have been on its own, kept warm so a
  // fallback starts from a real count rather than from zero.
  const memoryStore = new MemoryStore()

  /**
   * RedisStore.init() does not merely record options — it issues SCRIPT LOAD
   * and keeps the resulting promise on the instance. At boot the connection is
   * `lazyConnect` and not ready for a few seconds, so calling it eagerly
   * produced a REJECTED promise with nothing attached to it. Node terminates
   * the process on an unhandled rejection, so the server crash-looped on every
   * start before Redis came up.
   *
   * So the options are held and the Redis store is initialised lazily, the
   * first time there is a live client — and its script promises get a catch
   * attached the moment they exist.
   */
  let options: Options | null = null
  let redisInitialised = false

  const initRedisOnce = (): void => {
    if (redisInitialised || !options) return
    redisInitialised = true
    // init() is itself ASYNC and ends with `await Promise.all([…])` over the two
    // script promises, so THREE promises can reject here, not two. Every one of
    // them needs a handler attached in this same tick or Node sees an unhandled
    // rejection and takes the process down. The failure itself is dealt with by
    // the fallback below; these catches exist only so it stays a failure and
    // does not become a crash.
    void redisStore.init(options).catch(() => {})
    void Promise.resolve(redisStore.incrementScriptSha).catch(() => {})
    void Promise.resolve(redisStore.getScriptSha).catch(() => {})
  }

  const withFallback = async <T>(
    viaRedis: () => Promise<T> | T,
    viaMemory: () => Promise<T> | T,
  ): Promise<T> => {
    if (getCacheRedis()) {
      try {
        initRedisOnce()
        const out = await viaRedis()
        noteRecovered(prefix)
        return out
      } catch (err) {
        // Re-init next time. A failed SCRIPT LOAD leaves a permanently rejected
        // sha promise on the instance, so without this one blip would pin the
        // limiter to the in-memory count for the life of the process.
        redisInitialised = false
        noteDegraded(err, prefix)
      }
    } else {
      noteDegraded(new Error('no ready client'), prefix)
    }
    return viaMemory()
  }

  return {
    init(o: Options) {
      options = o
      memoryStore.init?.(o)
    },

    async increment(key: string): Promise<IncrementResponse> {
      return withFallback(
        () => redisStore.increment(key),
        () => memoryStore.increment(key),
      )
    },

    async decrement(key: string): Promise<void> {
      await withFallback(
        () => redisStore.decrement(key),
        () => memoryStore.decrement(key),
      )
    },

    async resetKey(key: string): Promise<void> {
      await withFallback(
        () => redisStore.resetKey(key),
        () => memoryStore.resetKey(key),
      )
    },

    async get(key: string): Promise<ClientRateLimitInfo | undefined> {
      return withFallback(
        () => redisStore.get?.(key),
        () => memoryStore.get?.(key),
      )
    },

    async shutdown(): Promise<void> {
      // Only the memory store owns anything to release — its sweep timer. The
      // Redis connection is lib/redis's and is closed by disconnectRedis.
      memoryStore.shutdown?.()
    },

    // False because the counts are NOT process-local in the normal case, which
    // is the whole point. express-rate-limit uses this only to warn about
    // double-counting misconfigurations.
    localKeys: false,
    prefix,
  }
}
