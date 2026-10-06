/**
 * The delivery reaches the truck at once, and costs one query to do it.
 *
 * The declared load has always been derivable — `handleSale` writes the tonnage
 * to a dispatch row and `getFleetSnapshot` overrides the vehicle's cargo fields
 * from it. What it did not do was ARRIVE: that path runs through the
 * `open-trips` warm cache, which sweeps once a minute and serves the stale
 * entry while it rebuilds, so a unit signed out with 29 t could read Empty for
 * two sweeps with the number sitting in the database the whole time.
 *
 * Two properties are pinned here, and they pull against each other:
 *
 *   IMMEDIACY   a sign-out publishes the load without waiting for a sweep.
 *   COST        a reconcile pass re-reading a thousand rows must not become a
 *               thousand rebuilds. A rebuild of this cache is measured at ~6 s
 *               and three at once took the API down on 2026-08-10, so this is
 *               not a tidiness argument — batching is what makes the immediacy
 *               safe to have at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const patchOpenTrips   = vi.fn()
const getOpenTripsCached = vi.fn()
const emitDashboardDispatch = vi.fn()

vi.mock('../../src/modules/dispatches/open-trips.cache.js', () => ({
  patchOpenTrips:     (...a: unknown[]) => patchOpenTrips(...a),
  getOpenTripsCached: (...a: unknown[]) => getOpenTripsCached(...a),
}))
vi.mock('../../src/lib/sse.js', () => ({
  emitDashboardDispatch: (...a: unknown[]) => emitDashboardDispatch(...a),
}))

const { markDispatchChanged, flushDispatchRefreshNow } =
  await import('../../src/modules/dispatches/dispatch-refresh.js')

const ORG = 'org-westsugar'
const run = (over: Record<string, unknown> = {}) => ({
  externalId: 'sale-1', driverName: 'Maxwell Masinde', destination: 'Raiply',
  dispatchedAt: '2026-09-22T03:22:00.000Z',
  cargoTonnes: 29, cargoBags: 580, cargoName: 'Processed Sugar',
  ...over,
})

beforeEach(() => {
  patchOpenTrips.mockReset()
  getOpenTripsCached.mockReset()
  emitDashboardDispatch.mockReset()
})

describe('dispatch refresh', () => {
  it('publishes the declared load for the unit that just signed out', async () => {
    patchOpenTrips.mockResolvedValue(['veh-1'])
    getOpenTripsCached.mockResolvedValue({ byVehicle: new Map([['veh-1', run()]]) })

    markDispatchChanged(ORG, 'veh-1')
    await flushDispatchRefreshNow()

    expect(emitDashboardDispatch).toHaveBeenCalledTimes(1)
    const [orgId, payload] = emitDashboardDispatch.mock.calls[0]!
    expect(orgId).toBe(ORG)
    expect(payload).toMatchObject({
      vehicleId: 'veh-1',
      // Kilograms on the wire, because that is the unit the vehicle's own
      // cargo field is in — the snapshot and this push must not disagree.
      cargoWeightKg: 29_000,
      cargoBags: 580,
      cargoDesc: 'Processed Sugar',
      destination: 'Raiply',
      driverName: 'Maxwell Masinde',
    })
  })

  it('empties the bed when the run has closed', async () => {
    patchOpenTrips.mockResolvedValue(['veh-1'])
    getOpenTripsCached.mockResolvedValue({ byVehicle: new Map() })

    markDispatchChanged(ORG, 'veh-1')
    await flushDispatchRefreshNow()

    expect(emitDashboardDispatch.mock.calls[0]![1]).toMatchObject({
      vehicleId: 'veh-1', cargoWeightKg: null, cargoBags: null, destination: null,
    })
  })

  it('collapses a reconcile burst into ONE cache query', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `veh-${i}`)
    patchOpenTrips.mockResolvedValue([])
    for (const id of ids) markDispatchChanged(ORG, id)
    await flushDispatchRefreshNow()

    expect(patchOpenTrips).toHaveBeenCalledTimes(1)
    expect(patchOpenTrips.mock.calls[0]![1]).toHaveLength(300)
  })

  it('says nothing when a redelivered webhook changed nothing', async () => {
    patchOpenTrips.mockResolvedValue([])
    getOpenTripsCached.mockResolvedValue({ byVehicle: new Map([['veh-1', run()]]) })

    markDispatchChanged(ORG, 'veh-1')
    await flushDispatchRefreshNow()

    expect(emitDashboardDispatch).not.toHaveBeenCalled()
    // Not even read: nothing changed, so there is nothing to narrate.
    expect(getOpenTripsCached).not.toHaveBeenCalled()
  })

  it('never lets a cache failure reach the ingest path', async () => {
    // The webhook must be acknowledged: a 4xx makes the provider retry a few
    // times and then DROP the event permanently. The minute sweep is the
    // fallback and it is unaffected by this failing.
    patchOpenTrips.mockRejectedValue(new Error('pooler timeout'))

    markDispatchChanged(ORG, 'veh-1')
    await expect(flushDispatchRefreshNow()).resolves.toBeUndefined()
    expect(emitDashboardDispatch).not.toHaveBeenCalled()
  })

  it('ignores an event with no vehicle bound to it', async () => {
    markDispatchChanged(ORG, null)
    await flushDispatchRefreshNow()
    expect(patchOpenTrips).not.toHaveBeenCalled()
  })
})

describe('the seal serial (FactorySuite v1.4.32)', () => {
  it('carries the run serial to the card', async () => {
    patchOpenTrips.mockResolvedValue(['veh-1'])
    getOpenTripsCached.mockResolvedValue({ byVehicle: new Map([['veh-1', run({ serialNumber: 'C098062' })]]) })

    markDispatchChanged(ORG, 'veh-1')
    await flushDispatchRefreshNow()

    expect(emitDashboardDispatch.mock.calls[0]![1]).toMatchObject({ serialNumber: 'C098062' })
  })

  it('sends null when the run has closed', async () => {
    patchOpenTrips.mockResolvedValue(['veh-1'])
    getOpenTripsCached.mockResolvedValue({ byVehicle: new Map() })

    markDispatchChanged(ORG, 'veh-1')
    await flushDispatchRefreshNow()

    expect(emitDashboardDispatch.mock.calls[0]![1]).toMatchObject({ serialNumber: null })
  })
})
