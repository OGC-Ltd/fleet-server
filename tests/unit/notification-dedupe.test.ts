/**
 * `publishNotification` is the one place a feed item is born, and therefore the
 * only place duplicate suppression can be complete.
 *
 * Postgres already guaranteed one ROW per feedId. Nothing downstream of it did:
 * SSE re-emitted on every republish, which put two siblings with the same React
 * key in the dashboard panel — React keeps the first and stops updating the
 * rest, which is why the Live Feed appeared to freeze until a page reload. The
 * fuel sync made it constant rather than occasional, because it publishes by
 * event AGE and re-offers each event on every cycle inside a 2-hour window.
 *
 * These pin the two halves of the contract: an identical re-offer reaches
 * nothing, and a CORRECTED one still goes out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/sse.js', () => ({ emitDashboardFeed: vi.fn() }))
vi.mock('../../src/lib/notifications/notification-cache.js', () => ({ cacheNotification: vi.fn() }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { emitDashboardFeed } from '../../src/lib/sse.js'
import { cacheNotification } from '../../src/lib/notifications/notification-cache.js'
import {
  publishNotification, publishNotificationDurable, __resetPublishDedupe,
} from '../../src/lib/notifications/notification.store.js'

const AT = new Date('2026-08-02T11:30:00Z')

const fill = (over: Record<string, unknown> = {}) => ({
  orgId:     'org_1',
  id:        'fuel-fill-veh_1-1754134200000',
  source:    'wialon',
  alertType: 'fuelFilling',
  severity:  'info' as const,
  text:      'CTR 03 refuelled 40 L at Nyalulanga. Tank now 760 L.',
  at:        AT,
  plate:     'CTR 03',
  vehicleId: 'veh_1',
  ...over,
})

beforeEach(() => {
  // The map is process-global by design (it must outlive any one poll cycle),
  // so it leaks between cases unless cleared.
  __resetPublishDedupe()
  vi.mocked(emitDashboardFeed).mockClear()
  vi.mocked(cacheNotification).mockClear()
  // publishNotification detaches the write and attaches a .catch to it, so the
  // upsert has to return a real promise — mockDeep's default undefined throws
  // inside the detached call rather than at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.notification.upsert as any).mockResolvedValue({})
})

describe('publishNotification dedupe', () => {
  it('emits an event once, however many times it is re-offered', () => {
    // Eight cycles inside the fuel notify window offering the same filling.
    for (let i = 0; i < 8; i++) publishNotification(fill())

    expect(emitDashboardFeed).toHaveBeenCalledTimes(1)
    expect(cacheNotification).toHaveBeenCalledTimes(1)
    expect(prismaMock.notification.upsert).toHaveBeenCalledTimes(1)
  })

  it('still returns the item when it suppresses it', () => {
    // Callers use the return value to build a response; a suppressed publish is
    // not an error and must not hand back a hole.
    publishNotification(fill())
    const item = publishNotification(fill())

    expect(item.id).toBe('fuel-fill-veh_1-1754134200000')
    expect(item.text).toContain('refuelled 40 L')
  })

  it('lets a CORRECTED redelivery through', () => {
    // Wialon refines a filling's volume and final level as settled readings
    // arrive, so a republished event is routinely almost-but-not-quite the same.
    // Suppressing those would freeze the first, roughest figure on the feed.
    publishNotification(fill())
    publishNotification(fill({ text: 'CTR 03 refuelled 42.5 L at Nyalulanga. Tank now 762.5 L.' }))

    expect(emitDashboardFeed).toHaveBeenCalledTimes(2)
  })

  it('lets a resolved vehicle through, even with identical wording', () => {
    // The org-attribution fix links a plate to a vehicle on a later pass; the
    // text does not change, but the item becomes clickable on the map.
    publishNotification(fill({ vehicleId: null }))
    publishNotification(fill({ vehicleId: 'veh_1' }))

    expect(emitDashboardFeed).toHaveBeenCalledTimes(2)
  })

  it('does not confuse two events that differ only by timestamp', () => {
    // Two fillings for one vehicle in a window are distinct events with
    // distinct feedIds — the dedupe must key on the id, not on the vehicle.
    publishNotification(fill())
    publishNotification(fill({ id: 'fuel-fill-veh_1-1754137800000', at: new Date('2026-08-02T12:30:00Z') }))

    expect(emitDashboardFeed).toHaveBeenCalledTimes(2)
  })

  it('suppresses across the boot replay too', () => {
    // seedFeedFromStoredAlerts re-emits stored alerts with persist:false. A
    // live redelivery of one of those must not then appear a second time.
    publishNotification(fill({ persist: false }))
    publishNotification(fill())

    expect(emitDashboardFeed).toHaveBeenCalledTimes(1)
    // …and the replay must not have written anything either.
    expect(prismaMock.notification.upsert).not.toHaveBeenCalled()
  })
})

describe('publishNotificationDurable dedupe', () => {
  it('reports whether it published, and skips the pooler round trip when it did not', async () => {
    const first  = await publishNotificationDurable(fill())
    const second = await publishNotificationDurable(fill())

    expect(first.published).toBe(true)
    expect(second.published).toBe(false)
    // The upsert is idempotent but costs about a second on this connection;
    // an exact republish must not pay it.
    expect(prismaMock.notification.upsert).toHaveBeenCalledTimes(1)
    expect(cacheNotification).toHaveBeenCalledTimes(1)
  })

  it('shares its memory with the synchronous path', async () => {
    // The queue publishes durably and the poller publishes detached; one event
    // reaching the feed through both must still appear once.
    publishNotification(fill())
    const out = await publishNotificationDurable(fill())

    expect(out.published).toBe(false)
    expect(emitDashboardFeed).toHaveBeenCalledTimes(1)
  })
})
