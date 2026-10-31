/**
 * A unit's fuel incident reaches open dashboards without a reload.
 *
 * The snapshot is the only place a unit's open incident is decided, and a
 * browser reads it once, at page load; position frames cannot carry a fuel
 * verdict. So the CRITICAL count and the red marker stayed as they were until
 * somebody refreshed. Each snapshot build is now compared with the last, and
 * every unit whose incident changed is pushed as a `fuel_incident` event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const findFleetSnapshot = vi.fn()
const emitDashboardFuelIncident = vi.fn()

vi.mock('../../src/modules/telemetry/telemetry.repository.js', () => ({
  findFleetSnapshot: (orgId: string) => findFleetSnapshot(orgId),
}))
vi.mock('../../src/lib/sse.js', () => ({
  emitDashboardFuelIncident: (...a: unknown[]) => emitDashboardFuelIncident(...a),
}))

const unit = (vehicleId: string, incident: Record<string, unknown> | null = null) =>
  ({ vehicleId, fuelIncident: incident })
const theft = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, cause: 'SIPHON', mayUseTheftWording: true, ...extra })

let mod: typeof import('../../src/modules/telemetry/fleet-snapshot.cache.js')
let org = 0
/** A fresh org per test: the module keeps its baseline per org. */
const nextOrg = () => `org_${++org}`

beforeEach(async () => {
  findFleetSnapshot.mockReset()
  emitDashboardFuelIncident.mockReset()
  mod = await import('../../src/modules/telemetry/fleet-snapshot.cache.js')
})

afterEach(() => { vi.useRealTimers() })

/** Build the org's snapshot once from `units` (via the debounced rebuild). */
async function build(orgId: string, units: unknown[]) {
  findFleetSnapshot.mockResolvedValueOnce(units)
  vi.useFakeTimers()
  mod.refreshFleetSnapshotIncidents(orgId)
  await vi.advanceTimersByTimeAsync(2_000)
  vi.useRealTimers()
  // Let the rebuild's promise settle.
  await new Promise((r) => setTimeout(r, 0))
}

describe('fleet snapshot: fuel incident changes are pushed', () => {
  it('says nothing on the first build: there is nothing to compare against', async () => {
    const o = nextOrg()
    await build(o, [unit('v1', theft('t1')), unit('v2')])
    expect(emitDashboardFuelIncident).not.toHaveBeenCalled()
  })

  it('pushes a newly raised incident, for that unit only', async () => {
    const o = nextOrg()
    await build(o, [unit('v1'), unit('v2')])
    await build(o, [unit('v1', theft('t1')), unit('v2')])

    expect(emitDashboardFuelIncident).toHaveBeenCalledTimes(1)
    expect(emitDashboardFuelIncident).toHaveBeenCalledWith(o, { vehicleId: 'v1', fuelIncident: theft('t1') })
  })

  it('pushes null when an incident is cleared, so the unit stops counting as critical', async () => {
    const o = nextOrg()
    await build(o, [unit('v1', theft('t1'))])
    await build(o, [unit('v1')])

    expect(emitDashboardFuelIncident).toHaveBeenCalledWith(o, { vehicleId: 'v1', fuelIncident: null })
  })

  it('pushes a change to the same incident (a review), and nothing when it is unchanged', async () => {
    const o = nextOrg()
    await build(o, [unit('v1', theft('t1'))])
    await build(o, [unit('v1', theft('t1'))])
    expect(emitDashboardFuelIncident).not.toHaveBeenCalled()

    await build(o, [unit('v1', theft('t1', { review: { status: 'CONFIRMED_THEFT' } }))])
    expect(emitDashboardFuelIncident).toHaveBeenCalledTimes(1)
  })

  it('rebuilds once for a burst of fuel alerts', async () => {
    const o = nextOrg()
    findFleetSnapshot.mockResolvedValue([unit('v1')])
    vi.useFakeTimers()
    mod.refreshFleetSnapshotIncidents(o)
    mod.refreshFleetSnapshotIncidents(o)
    mod.refreshFleetSnapshotIncidents(o)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(findFleetSnapshot).toHaveBeenCalledTimes(1)
  })
})
