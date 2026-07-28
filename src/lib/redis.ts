/**
 * Redis connection — OPTIONAL by design.
 *
 * `REDIS_URL` unset means every consumer here degrades to Postgres rather than
 * failing. That is not defensive padding: the production box is a t3.micro
 * that is already swapping, so Redis cannot be installed on it until it is
 * resized. This module must therefore ship, deploy and run in production for a
 * while with no Redis behind it at all, and nothing may break in the meantime.
 *
 * Two separate connections, on two separate logical databases:
 *
 *   cache (db 0) — notification history. Evictable: losing it costs a slower
 *                  read that falls back to Postgres, nothing more.
 *   queue (db 1) — BullMQ job state. NOT evictable: an evicted job is work
 *                  silently never done. BullMQ also requires
 *                  maxRetriesPerRequest = null on its connections.
 *
 * Keeping them apart matters because the local Redis will be memory-capped
 * with an LRU eviction policy; without the split, cache churn could evict live
 * jobs. Configure redis.conf so only db 0 is under pressure — or, more simply,
 * size maxmemory so the queue never approaches it (job volume here is one
 * repeatable sweep a day).
 */

import Redis from 'ioredis'
import type { RedisOptions } from 'ioredis'
import { env } from '../config/env.js'
import { logger } from './logger.js'

export const CACHE_DB = 0
export const QUEUE_DB = 1

let cacheClient:  Redis | null = null
let queueClient:  Redis | null = null
let warnedNoRedis = false

/** True when a REDIS_URL is configured. Callers branch on this, not on errors. */
export function isRedisConfigured(): boolean {
  return Boolean(env.REDIS_URL)
}

function baseOptions(db: number): RedisOptions {
  return {
    db,
    // Fail fast and keep failing quietly: a Redis outage must never stall an
    // HTTP request or a poll cycle. Commands issued while down reject
    // immediately instead of queueing up behind a reconnect.
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    // Cap the backoff so a long outage doesn't leave us retrying once an hour.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    lazyConnect: true,
  }
}

function create(db: number, label: string, extra: RedisOptions = {}): Redis | null {
  if (!env.REDIS_URL) {
    if (!warnedNoRedis) {
      logger.warn('REDIS_URL not set — notification cache and BullMQ retention are DISABLED (reads fall back to Postgres)')
      warnedNoRedis = true
    }
    return null
  }

  const client = new Redis(env.REDIS_URL, { ...baseOptions(db), ...extra })

  // 'error' MUST have a listener or ioredis promotes it to an unhandled
  // exception and takes the process down — which is the opposite of optional.
  let loggedError = false
  client.on('error', (err) => {
    if (loggedError) return          // one line per outage, not per retry
    loggedError = true
    logger.warn({ err, redis: label }, 'Redis connection error — degrading to Postgres until it recovers')
  })
  client.on('ready', () => {
    loggedError = false
    logger.info({ redis: label, db }, 'Redis connected')
  })

  client.connect().catch(() => { /* retryStrategy owns reconnection from here */ })
  return client
}

/**
 * Cache connection, or null when it cannot serve a command right now.
 *
 * Null covers three cases the callers all treat identically — no REDIS_URL, a
 * connection still coming up, and an outage in progress. The readiness check
 * matters because `enableOfflineQueue: false` makes ioredis THROW on any
 * command issued before the socket is ready, and connecting takes a few
 * seconds after boot. Without it, every notification in that window raised an
 * exception that had to be caught and logged; now it simply skips the cache
 * and goes to Postgres, which is what it should have been doing anyway.
 */
export function getCacheRedis(): Redis | null {
  if (!env.REDIS_URL) return null
  cacheClient ??= create(CACHE_DB, 'cache')
  return cacheClient?.status === 'ready' ? cacheClient : null
}

/**
 * Queue connection for BullMQ, or null when Redis is not configured.
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands.
 */
export function getQueueRedis(): Redis | null {
  if (!env.REDIS_URL) return null
  queueClient ??= create(QUEUE_DB, 'queue', { maxRetriesPerRequest: null, enableOfflineQueue: true })
  return queueClient
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([cacheClient?.quit(), queueClient?.quit()])
  cacheClient = null
  queueClient = null
}
