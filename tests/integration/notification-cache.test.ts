/**
 * Notification cache behaviour against a REAL Redis.
 *
 * Skipped automatically when TEST_REDIS_URL is unset, so the suite still runs
 * on a machine (or CI box) with no Redis — which is also the production
 * posture until the t3.micro is resized.
 *
 * Start one with:  docker run -d --rm -p 6380:6379 --name fleet-test-redis redis:7-alpine
 * then:            TEST_REDIS_URL=redis://127.0.0.1:6380 npx vitest run notification-cache
 *
 * These drive the PRODUCTION Lua (TRIM_SCRIPT) rather than a re-typed sequence
 * of commands: the add-and-trim step is now atomic across two keys, and a test
 * that reimplemented it would stop testing the thing that can actually break.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Redis from 'ioredis'
import { TRIM_SCRIPT } from '../../src/lib/notifications/notification-cache.js'

const URL = process.env['TEST_REDIS_URL'] ?? ''
const d = URL ? describe : describe.skip

// Generous: TEST_REDIS_URL may point through an SSH tunnel to us-east-1, where
// a single round trip is ~250 ms rather than the sub-millisecond a local Redis
// gives. The default 5 s timeout fails on latency alone and leaves keys behind
// for the next test to trip over.
const TIMEOUT = 30_000

const DAY = 24 * 60 * 60_000

d('notification cache (real Redis)', { timeout: TIMEOUT }, () => {
  const redis = new Redis(URL, { db: 0, lazyConnect: true, maxRetriesPerRequest: 1 })
  const KEY  = 'notif:feed:test-org'
  const DATA = 'notif:data:test-org'

  const item = (id: string, tsMs: number, text = `event ${id}`) => ({
    id, ts: new Date(tsMs).toISOString(), time: '12:00',
    type: 'info', text, source: 'test',
  })

  /** One production write: the same eval cacheNotification issues. */
  const write = (
    it_: ReturnType<typeof item>,
    { max = 200, retentionDays = 90 }: { max?: number; retentionDays?: number } = {},
  ) => redis.eval(
    TRIM_SCRIPT, 2, KEY, DATA,
    String(Date.parse(it_.ts)), it_.id, JSON.stringify(it_),
    String(max), String(Date.now() - retentionDays * DAY), String(retentionDays * DAY / 1000),
  )

  /** Read back the way readCachedNotifications does: ids, then payloads. */
  const read = async (limit = -1) => {
    const ids = await redis.zrevrange(KEY, 0, limit)
    if (ids.length === 0) return []
    const payloads = await redis.hmget(DATA, ...ids)
    return payloads.flatMap(p => (p ? [JSON.parse(p)] : []))
  }

  beforeEach(async () => {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect()
    await redis.del(KEY, DATA)
  })

  afterAll(async () => { await redis.del(KEY, DATA); await redis.quit() })

  it('orders by event time, not insertion order', async () => {
    // The reconcile poller surfaces alerts the webhook missed, and fuel events
    // arrive up to two hours after they happened, so items arrive out of order.
    // A LIST would put them in arrival order; the ZSET must not.
    const t0 = Date.parse('2026-07-27T10:00:00Z')
    await write(item('newest', t0 + 2000))
    await write(item('oldest', t0))
    await write(item('middle', t0 + 1000))

    expect((await read()).map(i => i.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('caps the cache by count, discarding the oldest', async () => {
    const base = Date.parse('2026-07-27T10:00:00Z')
    const MAX = 5
    for (let i = 0; i < 12; i++) await write(item(`n${i}`, base + i * 1000), { max: MAX })

    const items = await read()
    expect(items).toHaveLength(MAX)
    // The newest MAX survive; everything older is gone. This is the assertion
    // that pins the trim arithmetic: `-(MAX + 1)` as the stop rank is easy to
    // get off by one, and being wrong by one silently shortens every feed.
    expect(items.map(i => i.id)).toEqual(['n11', 'n10', 'n9', 'n8', 'n7'])
  })

  it('drops the payload of everything it evicts', async () => {
    // The bug this guards: trimming the index without the hash leaks one
    // payload per evicted notification, forever, on the box's tightest
    // resource. The two keys must always hold the same set of ids.
    const base = Date.parse('2026-07-27T10:00:00Z')
    for (let i = 0; i < 12; i++) await write(item(`n${i}`, base + i * 1000), { max: 5 })

    expect(await redis.hlen(DATA)).toBe(5)
    expect((await redis.hkeys(DATA)).sort()).toEqual(['n10', 'n11', 'n7', 'n8', 'n9'])
  })

  it('drops entries past the retention horizon', async () => {
    const now = Date.now()
    await write(item('ancient', now - 100 * DAY))
    await write(item('recent',  now - 1 * DAY))

    expect((await read()).map(i => i.id)).toEqual(['recent'])
    expect(await redis.hkeys(DATA)).toEqual(['recent'])
  })

  it('re-publishing the same id updates in place instead of duplicating', async () => {
    // THE fuel bug. The member used to be the serialised payload, so identity
    // was the exact body: Wialon refines a filling's volume as settled readings
    // arrive, and a republished event whose text had drifted by one character
    // became a SECOND row at the same score — one event shown twice, while
    // Postgres (which upserts on feedId) held a single clean row.
    const t = Date.parse('2026-07-27T10:00:00Z')
    await write(item('fuel-fill-veh_1-123', t, 'CTR 03 refuelled 40 L'))
    await write(item('fuel-fill-veh_1-123', t, 'CTR 03 refuelled 42.5 L'))

    expect(await redis.zcard(KEY)).toBe(1)
    expect(await redis.hlen(DATA)).toBe(1)
    // …and the CORRECTED figure is what the feed serves.
    expect((await read())[0].text).toBe('CTR 03 refuelled 42.5 L')
  })

  it('reads a cache written by the PREVIOUS member format', async () => {
    // Deploy-day risk, measured against the live box on 2026-08-02: both orgs'
    // caches were full (200 members each) and every member was a JSON payload,
    // because that is what the member used to be. A reader that only understood
    // ids would have returned nothing for all of them — and since the reader
    // treats a full cache as an answer, the first page every dashboard loads
    // would have gone blank until the ZSET churned through, which for a quiet
    // org is days. This is the real function, not a re-implementation of it.
    const t = Date.parse('2026-07-27T10:00:00Z')
    await redis.zadd(KEY, t,        JSON.stringify(item('legacy-old', t)))
    await redis.zadd(KEY, t + 2000, JSON.stringify(item('legacy-new', t + 2000)))
    // …and one written the new way, because a live server produces a MIXED set
    // the moment it starts writing.
    await write(item('modern', t + 1000))

    vi.stubEnv('REDIS_URL', URL)
    // Imported after the stub: the module reads env at load, and vitest caches
    // modules across files, so a plain top-level import would bind to a null
    // client and silently return null for everything.
    vi.resetModules()
    const { readCachedNotifications } = await import('../../src/lib/notifications/notification-cache.js')

    // getCacheRedis() only answers once its socket is ready, which takes a
    // moment on a fresh connection.
    let items: Awaited<ReturnType<typeof readCachedNotifications>> = null
    for (let i = 0; i < 40 && !items; i++) {
      items = await readCachedNotifications('test-org', 10)
      if (!items) await new Promise(r => setTimeout(r, 250))
    }

    expect(items?.map(i => i.id)).toEqual(['legacy-new', 'modern', 'legacy-old'])
    expect(items?.find(i => i.id === 'legacy-old')?.text).toBe('event legacy-old')

    vi.unstubAllEnvs()
    const { disconnectRedis } = await import('../../src/lib/redis.js')
    await disconnectRedis()
  })

  it('keeps a past-dated event that is still inside the cap', async () => {
    // A fuel event arrives with a timestamp up to two hours old. It must land
    // in its correct chronological slot and stay there — not be evicted by the
    // rank trim on the way in, which is what buried them for the noisy org.
    const now = Date.now()
    await write(item('zone-a', now - 60_000))
    await write(item('fuel',   now - 90 * 60_000))
    await write(item('zone-b', now))

    expect((await read()).map(i => i.id)).toEqual(['zone-b', 'zone-a', 'fuel'])
  })
})
