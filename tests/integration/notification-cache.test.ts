/**
 * Notification cache behaviour against a REAL Redis.
 *
 * Skipped automatically when TEST_REDIS_URL is unset, so the suite still runs
 * on a machine (or CI box) with no Redis — which is also the production
 * posture until the t3.micro is resized.
 *
 * Start one with:  docker run -d --rm -p 6380:6379 --name fleet-test-redis redis:7-alpine
 * then:            TEST_REDIS_URL=redis://127.0.0.1:6380 npx vitest run notification-cache
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Redis from 'ioredis'

const URL = process.env['TEST_REDIS_URL'] ?? ''
const d = URL ? describe : describe.skip

// Generous: TEST_REDIS_URL may point through an SSH tunnel to us-east-1, where
// a single round trip is ~250 ms rather than the sub-millisecond a local Redis
// gives. The default 5 s timeout fails on latency alone and leaves keys behind
// for the next test to trip over.
const TIMEOUT = 30_000

d('notification cache (real Redis)', { timeout: TIMEOUT }, () => {
  const redis = new Redis(URL, { db: 0, lazyConnect: true, maxRetriesPerRequest: 1 })
  const KEY = 'notif:feed:test-org'

  const item = (id: string, tsMs: number) => ({
    id, ts: new Date(tsMs).toISOString(), time: '12:00',
    type: 'info', text: `event ${id}`, source: 'test',
  })

  beforeEach(async () => {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect()
    await redis.del(KEY)
  })

  afterAll(async () => { await redis.del(KEY); await redis.quit() })

  it('orders by event time, not insertion order', async () => {
    // The reconcile poller surfaces alerts the webhook missed, so items arrive
    // out of order. A LIST would put them in arrival order; the ZSET must not.
    const t0 = Date.parse('2026-07-27T10:00:00Z')
    await redis.zadd(KEY, t0 + 2000, JSON.stringify(item('newest', t0 + 2000)))
    await redis.zadd(KEY, t0,        JSON.stringify(item('oldest', t0)))
    await redis.zadd(KEY, t0 + 1000, JSON.stringify(item('middle', t0 + 1000)))

    const raw = await redis.zrevrange(KEY, 0, -1)
    expect(raw.map(s => JSON.parse(s).id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('caps the cache by count, discarding the oldest', async () => {
    const base = Date.parse('2026-07-27T10:00:00Z')
    const MAX = 5
    // Pipelined: this Redis may be remote (an SSH tunnel to the box), where 24
    // sequential round trips take longer than the default test timeout. The
    // add-then-trim pairing is what production does per notification, so the
    // sequence under test is unchanged — only the number of round trips is.
    const pipe = redis.pipeline()
    for (let i = 0; i < 12; i++) {
      pipe.zadd(KEY, base + i * 1000, JSON.stringify(item(`n${i}`, base + i * 1000)))
      pipe.zremrangebyrank(KEY, 0, -(MAX + 1))
    }
    await pipe.exec()

    const raw = await redis.zrevrange(KEY, 0, -1)
    expect(raw).toHaveLength(MAX)
    // The newest MAX survive; everything older is gone. This is the assertion
    // that pins the trim arithmetic: `-(MAX + 1)` as the stop rank is easy to
    // get off by one, and being wrong by one silently shortens every feed.
    expect(raw.map(s => JSON.parse(s).id)).toEqual(['n11', 'n10', 'n9', 'n8', 'n7'])
  })

  it('drops entries past the retention horizon', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60_000
    await redis.zadd(KEY, now - 100 * day, JSON.stringify(item('ancient', now - 100 * day)))
    await redis.zadd(KEY, now - 1 * day,   JSON.stringify(item('recent',  now - 1 * day)))

    const cutoff = now - 90 * day
    const removed = await redis.zremrangebyscore(KEY, '-inf', cutoff)

    expect(removed).toBe(1)
    const raw = await redis.zrevrange(KEY, 0, -1)
    expect(raw.map(s => JSON.parse(s).id)).toEqual(['recent'])
  })

  it('re-adding the same id does not duplicate the feed', async () => {
    // A webhook redelivery and a reconcile pass can both surface one alert.
    const t = Date.parse('2026-07-27T10:00:00Z')
    const payload = JSON.stringify(item('pa-123', t))
    await redis.zadd(KEY, t, payload)
    await redis.zadd(KEY, t, payload)
    expect(await redis.zcard(KEY)).toBe(1)
  })
})
