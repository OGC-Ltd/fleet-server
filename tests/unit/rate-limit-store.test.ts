/**
 * The rate-limit counter, and whether it survives being spread across processes.
 *
 * express-rate-limit's MemoryStore keeps the count in the node process, so
 * "100 per second" silently meant "100 per second PER PROCESS". Exact under one
 * pm2 fork, wrong the moment anyone scales — and wrong in the direction nobody
 * notices, because the RateLimit response headers keep reporting a plausible
 * remaining count from whichever bucket answered.
 *
 * Two properties are pinned here. That the count is genuinely SHARED, which is
 * the claim being made and the thing MemoryStore cannot do. And that losing
 * Redis degrades to counting in memory rather than to 500ing every request or
 * admitting everything — Redis is optional in this codebase and every other
 * consumer falls back rather than failing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Options } from 'express-rate-limit'

/**
 * Enough Redis to run rate-limit-redis's increment script honestly.
 *
 * The script is `PTTL`, then either `SET key 1 PX windowMs` returning
 * { 1, windowMs } or `INCR key` returning { totalHits, timeToExpire }. Emulating
 * it — rather than stubbing `increment` — is what makes the sharing assertion
 * mean something: two stores are shown to converge through the BACKEND, not
 * through a mock that was told to agree.
 */
function fakeRedis() {
  const keys = new Map<string, { hits: number; expiresAt: number }>()
  const calls: string[][] = []

  const call = vi.fn(async (cmd: string, ...args: string[]) => {
    calls.push([cmd, ...args])
    const c = cmd.toUpperCase()

    if (c === 'SCRIPT') return 'sha-' + (args[1]?.includes('INCR') ? 'increment' : 'get')

    if (c === 'EVALSHA') {
      const sha = args[0]!
      const key = args[2]!
      const now = Date.now()
      const live = keys.get(key)
      const valid = live && live.expiresAt > now

      if (sha === 'sha-get') {
        return valid ? [String(live!.hits), live!.expiresAt - now] : [null, -1]
      }
      const windowMs = Number(args[3])
      if (!valid) {
        keys.set(key, { hits: 1, expiresAt: now + windowMs })
        return [1, windowMs]
      }
      live!.hits += 1
      return [live!.hits, live!.expiresAt - now]
    }

    if (c === 'DECR') { const e = keys.get(args[0]!); if (e) e.hits -= 1; return e?.hits ?? 0 }
    if (c === 'DEL')  { keys.delete(args[0]!); return 1 }
    return null
  })

  return { client: { call }, keys, calls }
}

let ready: { call: ReturnType<typeof vi.fn> } | null = null

vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => ready,
  getQueueRedis: () => null,
  isRedisConfigured: () => Boolean(ready),
  CACHE_DB: 0, QUEUE_DB: 1,
  disconnectRedis: async () => {},
}))

import { createRateLimitStore } from '../../src/middleware/rate-limit-store.js'

const WINDOW = 60_000
const opts = { windowMs: WINDOW } as Options

const build = (prefix = 'rl:test:') => {
  const store = createRateLimitStore(prefix)
  store.init?.(opts)
  return store
}

beforeEach(() => { ready = null; vi.clearAllMocks() })

describe('when Redis is available', () => {
  it('counts through Redis, not in the process', async () => {
    const fake = fakeRedis()
    ready = fake.client

    const store = build()
    await store.increment('1.2.3.4')

    expect(fake.client.call).toHaveBeenCalled()
    expect(fake.calls.some(([c]) => c.toUpperCase() === 'EVALSHA')).toBe(true)
  })

  /**
   * The whole point. Two stores stand in for two node processes; a MemoryStore
   * in each would report 1 and 1.
   */
  it('lets two separate stores see each other’s counts', async () => {
    const fake = fakeRedis()
    ready = fake.client

    const processA = build()
    const processB = build()

    const first  = await processA.increment('9.9.9.9')
    const second = await processB.increment('9.9.9.9')

    expect(first.totalHits).toBe(1)
    expect(second.totalHits).toBe(2)
  })

  it('keeps different clients in different buckets', async () => {
    const fake = fakeRedis()
    ready = fake.client
    const store = build()

    await store.increment('10.0.0.1')
    await store.increment('10.0.0.1')
    const other = await store.increment('10.0.0.2')

    expect(other.totalHits).toBe(1)
  })

  /**
   * Cache DB 0 is `volatile-lru`, which only evicts keys carrying a TTL. A
   * rate-limit key without one would be permanently resident and would compete
   * with BullMQ for the same maxmemory — and the queue DB is deliberately
   * `noeviction` because an evicted job is work silently never done.
   */
  it('gives every key an expiry', async () => {
    const fake = fakeRedis()
    ready = fake.client
    const store = build()

    await store.increment('7.7.7.7')
    for (const entry of fake.keys.values()) {
      expect(entry.expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it('namespaces each limiter separately', async () => {
    const fake = fakeRedis()
    ready = fake.client

    await build('rl:global:').increment('5.5.5.5')
    await build('rl:login:').increment('5.5.5.5')

    // One client, two limiters, two independent windows.
    expect([...fake.keys.keys()].sort()).toEqual(['rl:global:5.5.5.5', 'rl:login:5.5.5.5'])
  })
})

describe('when Redis is not there', () => {
  it('still counts, in memory', async () => {
    ready = null
    const store = build()

    expect((await store.increment('1.1.1.1')).totalHits).toBe(1)
    expect((await store.increment('1.1.1.1')).totalHits).toBe(2)
    expect((await store.increment('1.1.1.1')).totalHits).toBe(3)
  })

  /**
   * The direction of failure matters. Falling back to memory keeps limiting;
   * throwing would 500 every request on the platform, and returning a zero
   * count would admit everything.
   */
  it('does not throw, and does not admit everything', async () => {
    ready = null
    const store = build()
    await expect(store.increment('2.2.2.2')).resolves.toMatchObject({ totalHits: 1 })
  })

  it('keeps separate buckets in the fallback too', async () => {
    ready = null
    const store = build()
    await store.increment('3.3.3.3')
    await store.increment('3.3.3.3')
    expect((await store.increment('4.4.4.4')).totalHits).toBe(1)
  })
})

describe('when Redis fails mid-flight', () => {
  it('falls back rather than propagating the error', async () => {
    ready = { call: vi.fn(async () => { throw new Error('READONLY You can not write against a read only replica') }) }
    const store = build()

    const out = await store.increment('6.6.6.6')
    expect(out.totalHits).toBe(1)
  })

  it('recovers to the shared count once Redis returns', async () => {
    const failing = { call: vi.fn(async () => { throw new Error('connection lost') }) }
    ready = failing
    const store = build()
    await store.increment('8.8.8.8')          // counted in memory

    const fake = fakeRedis()
    ready = fake.client
    await store.increment('8.8.8.8')          // back on Redis

    expect(fake.calls.some(([c]) => c.toUpperCase() === 'EVALSHA')).toBe(true)
  })
})
