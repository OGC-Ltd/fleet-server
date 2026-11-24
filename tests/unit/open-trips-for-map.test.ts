/**
 * The map never waits on a cold open-trips build (open-trips.cache,
 * getOpenTripsForMap). On 2026-11-24 every SUKARI build ran past 60 s, and the
 * snapshot waited on it, so the map showed no units at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const get = vi.fn()
vi.mock('../../src/lib/warm-cache.js', () => ({ createWarmCache: () => ({ get }) }))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))
vi.mock('../../src/modules/dispatches/dispatch.repository.js', () => ({ findOpenTripsByVehicle: vi.fn() }))

const { getOpenTripsForMap, MAP_TRIPS_WAIT_MS } = await import('../../src/modules/dispatches/open-trips.cache.js')

const trips = { yard: { lat: 1, lng: 2 }, yardName: 'Sukari', byVehicle: new Map([['v1', {}]]) }

describe('getOpenTripsForMap', () => {
  beforeEach(() => { vi.useFakeTimers(); get.mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it('hands back the cached trips when they are there', async () => {
    get.mockResolvedValue(trips)
    await expect(getOpenTripsForMap('org')).resolves.toBe(trips)
  })

  it('goes on with no trips when the build outlasts the wait', async () => {
    get.mockReturnValue(new Promise(() => {}))
    const p = getOpenTripsForMap('org')
    await vi.advanceTimersByTimeAsync(MAP_TRIPS_WAIT_MS)
    const r = await p
    expect(r.yard).toBeNull()
    expect(r.byVehicle.size).toBe(0)
  })

  it('goes on with no trips when the build fails', async () => {
    get.mockReturnValue(Promise.reject(new Error('Query read timeout')))
    const r = await getOpenTripsForMap('org')
    expect(r.byVehicle.size).toBe(0)
  })
})
