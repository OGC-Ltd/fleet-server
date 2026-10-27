/**
 * The history endpoint's FILTERED reads.
 *
 * Two things have to hold for the map's per-vehicle Live Feed, and neither is
 * visible from the call site:
 *
 *  1. A filtered read must not be answered from the Redis cache. The cache is
 *     one mixed, capped, chronological set for the whole organisation, so on a
 *     224-vehicle fleet the rows matching any one vehicle are exactly the rows
 *     it evicted — it would answer "no activity" for a truck that has been
 *     working all week.
 *  2. A filtered read must not PRIME the cache with its results, or the next
 *     unfiltered dashboard load would get one vehicle's history presented as
 *     the whole organisation's feed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification-cache.js', () => ({
  readCachedNotifications: vi.fn(),
  primeCache:              vi.fn(),
  // The per-vehicle-day pair. A factory mock replaces the module WHOLESALE, so
  // anything the subject imports and this omits is `undefined` at the call site
  // — which surfaces as "not a function" from inside the reader rather than as
  // a missing-export error, several frames from the cause.
  readCachedVehicleDay:    vi.fn(),
  cacheVehicleDay:         vi.fn(),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { readCachedNotifications, primeCache, readCachedVehicleDay, cacheVehicleDay } from '../../src/lib/notifications/notification-cache.js'
import { getNotifications } from '../../src/lib/notifications/notification.reader.js'
import { fleetDayKey } from '../../src/lib/provider-time.js'

const row = (over: Record<string, unknown> = {}) => ({
  feedId:     'zn-veh_1-zone_9-entry-1754134200000',
  severity:   'warning',
  text:       'CTR 03 entered Mlimani drain',
  source:     'zone',
  alertType:  'ZONE_ENTRY',
  plate:      'CTR 03',
  vehicleId:  'veh_1',
  occurredAt: new Date('2026-08-02T11:30:00Z'),
  ...over,
})

beforeEach(() => {
  vi.mocked(readCachedNotifications).mockReset()
  vi.mocked(primeCache).mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.notification.findMany as any).mockResolvedValue([row()])
})

describe('getNotifications — vehicleId filter', () => {
  it('scopes the query to that vehicle within the organisation', async () => {
    await getNotifications('org_1', { vehicleId: 'veh_1', limit: 100 })

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where:   { organisationId: 'org_1', vehicleId: 'veh_1', source: { notIn: ['repair_flag', 'repair_ticket'] } },
        orderBy: { occurredAt: 'desc' },
        take:    100,
      }),
    )
  })

  it('goes to Postgres even for the first page, and never consults the cache', async () => {
    const page = await getNotifications('org_1', { vehicleId: 'veh_1' })

    expect(readCachedNotifications).not.toHaveBeenCalled()
    expect(page.source).toBe('database')
    expect(page.items).toHaveLength(1)
  })

  it('does not prime the org cache from a single vehicle’s history', async () => {
    await getNotifications('org_1', { vehicleId: 'veh_1' })
    expect(primeCache).not.toHaveBeenCalled()
  })

  it('still serves the UNfiltered first page from the cache', async () => {
    vi.mocked(readCachedNotifications).mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        id: `x-${i}`, time: '14:30', ts: '2026-08-02T11:30:00.000Z',
        type: 'info', text: 't', source: 'zone', alertType: null,
        plate: null, vehicleId: null,
      })),
    )

    const page = await getNotifications('org_1')

    expect(page.source).toBe('cache')
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled()
  })
})

/**
 * The per-vehicle DAY read, and the second cache that exists only because a day
 * is a shape the org feed's cache cannot represent.
 *
 * The org cache is capped and mixed, so it can only answer "the newest N across
 * everything" — which is why every filtered read above goes to Postgres. A
 * vehicle-day is the opposite: bounded, complete, and once the day is over it
 * can never change. That is what makes it safe to cache, and these tests pin
 * the three conditions that keep it safe.
 */
describe('one vehicle, one fleet day', () => {
  const DAY = '2026-08-02'
  // Africa/Nairobi is +03:00 with no DST, so the day runs 21:00 the night
  // before to 21:00 UTC. A UTC-midnight reading would file the first three
  // hours of every fleet day under the previous one.
  const FROM = new Date('2026-08-01T21:00:00.000Z')
  const TO   = new Date('2026-08-02T21:00:00.000Z')

  const whereOf = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prismaMock.notification.findMany as any).mock.calls[0][0].where

  it('bounds the query to the FLEET day, not the UTC one', async () => {
    await getNotifications('org_1', { vehicleId: 'veh_1', day: DAY })
    expect(whereOf().occurredAt).toEqual({ gte: FROM, lt: TO })
  })

  it('serves a completed day from its own cache, and does not touch Postgres', async () => {
    vi.mocked(readCachedVehicleDay).mockResolvedValue([{ id: 'cached' } as never])
    const page = await getNotifications('org_1', { vehicleId: 'veh_1', day: DAY })

    expect(page.source).toBe('cache')
    expect(page.items).toHaveLength(1)
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled()
  })

  /**
   * An EMPTY day is an answer, not a miss. A unit that reported nothing is the
   * commonest result and the most wasteful to re-derive, so `[]` must be served
   * from the cache rather than falling through — which is why the cache read
   * returns null for "not cached" instead of an empty array.
   */
  it('serves a cached EMPTY day rather than re-querying', async () => {
    vi.mocked(readCachedVehicleDay).mockResolvedValue([])
    const page = await getNotifications('org_1', { vehicleId: 'veh_1', day: DAY })

    expect(page.source).toBe('cache')
    expect(page.items).toEqual([])
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled()
  })

  it('writes a completed day back after a miss — including an empty one', async () => {
    vi.mocked(readCachedVehicleDay).mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.notification.findMany as any).mockResolvedValue([])

    const page = await getNotifications('org_1', { vehicleId: 'veh_1', day: DAY })

    expect(page.source).toBe('database')
    expect(cacheVehicleDay).toHaveBeenCalledWith('veh_1', DAY, [], FROM.getTime())
  })

  /**
   * TODAY is never cached. A day still running would freeze a partial answer
   * that never updates, which is worse than a slow one because it looks
   * authoritative.
   */
  it('never caches a day that has not finished', async () => {
    // Both days come from `fleetDayKey`, the same clock the reader judges
    // "finished" by. Deriving them from the UTC date instead made this test
    // fail for the three hours between EAT midnight and UTC midnight (21:00-
    // 00:00 UTC): the UTC "today" is by then yesterday in Ndhiwa, so it IS a
    // completed day and caching it is correct. Tomorrow alone would pass, but
    // today is the case worth asserting.
    const today = fleetDayKey().toISOString().slice(0, 10)
    const tomorrow = fleetDayKey(new Date(Date.now() + 86_400_000)).toISOString().slice(0, 10)

    for (const d of [today, tomorrow]) {
      vi.mocked(cacheVehicleDay).mockClear()
      vi.mocked(readCachedVehicleDay).mockClear()
      await getNotifications('org_1', { vehicleId: 'veh_1', day: d })
      expect(readCachedVehicleDay).not.toHaveBeenCalled()
      expect(cacheVehicleDay).not.toHaveBeenCalled()
    }
  })

  /**
   * A day is the complete answer to a question, not a page of one — so it is
   * allowed past the 200 the scrolling org feed is bounded by. The busiest
   * measured vehicle-day carried 154 notifications.
   */
  it('lets a whole day past the paging cap', async () => {
    await getNotifications('org_1', { vehicleId: 'veh_1', day: DAY, limit: 500 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.notification.findMany as any).mock.calls[0][0].take).toBe(500)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.notification.findMany as any).mockClear()
    await getNotifications('org_1', { limit: 500 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.notification.findMany as any).mock.calls[0][0].take).toBe(200)
  })

  it('does not cache a day whose read hit the cap, which would freeze a truncated one', async () => {
    vi.mocked(readCachedVehicleDay).mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.notification.findMany as any).mockResolvedValue(Array.from({ length: 5 }, () => row()))

    await getNotifications('org_1', { vehicleId: 'veh_1', day: DAY, limit: 5 })
    expect(cacheVehicleDay).not.toHaveBeenCalled()
  })

  it('leaves the ORG feed cache alone entirely', async () => {
    vi.mocked(readCachedVehicleDay).mockResolvedValue(null)
    await getNotifications('org_1', { vehicleId: 'veh_1', day: DAY })

    expect(readCachedNotifications).not.toHaveBeenCalled()
    expect(primeCache).not.toHaveBeenCalled()
  })
})

describe('the whole fleet, one fleet day', () => {
  it('is read from Postgres, not answered by the org cache whatever its day', async () => {
    // The cache is full of the latest rows, which span midnight.
    vi.mocked(readCachedNotifications).mockResolvedValue(Array.from({ length: 200 }, () => ({ id: 'x' })) as never)

    const page = await getNotifications('org_1', { day: '2026-09-25', limit: 200 })

    expect(readCachedNotifications).not.toHaveBeenCalled()
    expect(page.source).toBe('database')
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organisationId: 'org_1',
        occurredAt: { gte: new Date('2026-09-24T21:00:00Z'), lt: new Date('2026-09-25T21:00:00Z') },
      }),
    }))
  })

  it('does not prime the org cache from a day-bounded page', async () => {
    await getNotifications('org_1', { day: '2026-09-20' })
    expect(primeCache).not.toHaveBeenCalled()
  })
})

describe('getNotifications — vehicle scope', () => {
  it('reads only the units in scope, from Postgres, without priming the cache', async () => {
    const page = await getNotifications('org_1', { vehicleIds: new Set(['veh_1', 'veh_2']) })

    expect(readCachedNotifications).not.toHaveBeenCalled()
    expect(primeCache).not.toHaveBeenCalled()
    expect(page.source).toBe('database')
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: 'org_1', vehicleId: { in: ['veh_1', 'veh_2'] }, source: { notIn: ['repair_flag', 'repair_ticket'] } } }),
    )
  })

  it('answers nothing for a vehicle outside the scope', async () => {
    vi.mocked(prismaMock.notification.findMany).mockClear()
    const page = await getNotifications('org_1', { vehicleId: 'veh_9', vehicleIds: new Set(['veh_1']) })

    expect(page.items).toEqual([])
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled()
  })
})

describe('getNotifications — restricted sources', () => {
  it('shows repair ticket notices only to a reader granted them', async () => {
    await getNotifications('org_1', { vehicleId: 'veh_1', grants: ['repair_ticket'] })
    expect(prismaMock.notification.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ source: { notIn: ['repair_flag'] } }),
    }))
  })
})
