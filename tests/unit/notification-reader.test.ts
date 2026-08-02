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
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { readCachedNotifications, primeCache } from '../../src/lib/notifications/notification-cache.js'
import { getNotifications } from '../../src/lib/notifications/notification.reader.js'

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
        where:   { organisationId: 'org_1', vehicleId: 'veh_1' },
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
