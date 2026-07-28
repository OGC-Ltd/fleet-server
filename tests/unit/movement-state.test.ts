import { describe, it, expect } from 'vitest'
import { noteMovement, movementState } from '../../src/lib/movement-state.js'

/**
 * The scenario that misreported 18 of 78 online units on production.
 *
 * A vehicle is ALREADY idling when the server boots — engine running, parked
 * up in the yard. The tracker has never witnessed it move, so its run is
 * inferred (`exact: false`) from first sighting, and the database's newest
 * moving ping is older than that. That combination takes the backdating branch
 * in movementState, which used to hardcode `state: 'resting'` and throw the
 * measured ignition verdict away — surfacing as ENGINE ON beside PARKED.
 */
const MIN = 60_000

describe('movementState — a run already under way at boot', () => {
  it('keeps the IDLING verdict while backdating the start time', () => {
    const id = 'veh-idling-at-boot'
    const stoppedMovingAt = Date.now() - 300 * MIN   // last moving ping, per the DB
    const firstSeenAt     = Date.now() - 30 * MIN    // this process's first frame

    // Every frame since boot: stationary, ignition measured ON.
    noteMovement(id, 0, firstSeenAt, true)
    noteMovement(id, 0, Date.now() - 10 * MIN, true)
    noteMovement(id, 0, Date.now() - 1 * MIN, true)

    const m = movementState(id, new Date(stoppedMovingAt), Date.now() - 1 * MIN)

    expect(m?.state).toBe('idling')          // was 'resting' before the fix
    expect(m?.moving).toBe(false)
    // Start time still comes from the database, so the duration is not reset
    // to "since the server restarted".
    expect(Date.parse(m!.since)).toBe(stoppedMovingAt)
  })

  it('still reports RESTING when the ignition is measured off', () => {
    const id = 'veh-resting-at-boot'
    const stoppedMovingAt = Date.now() - 300 * MIN

    noteMovement(id, 0, Date.now() - 30 * MIN, false)
    noteMovement(id, 0, Date.now() - 1 * MIN, false)

    const m = movementState(id, new Date(stoppedMovingAt), Date.now() - 1 * MIN)

    expect(m?.state).toBe('resting')
    expect(Date.parse(m!.since)).toBe(stoppedMovingAt)
  })

  it('still reports RESTING when the unit reports no ignition at all', () => {
    const id = 'veh-no-ignition-line'
    const stoppedMovingAt = Date.now() - 300 * MIN

    // null = the unit has no ignition sensor; idling is not claimable.
    noteMovement(id, 0, Date.now() - 30 * MIN, null)
    noteMovement(id, 0, Date.now() - 1 * MIN, null)

    expect(movementState(id, new Date(stoppedMovingAt), Date.now() - 1 * MIN)?.state).toBe('resting')
  })

  it('a silent unit still collapses to resting however its run was graded', () => {
    const id = 'veh-gone-quiet'
    const longAgo = Date.now() - 3000 * MIN

    noteMovement(id, 0, longAgo, true)   // was idling when last heard from

    // Newest fix is older than STALE_FIX_MS — we cannot claim it is idling now.
    const m = movementState(id, new Date(longAgo - MIN), longAgo)
    expect(m?.state).toBe('resting')
  })

  it('does not backdate once a transition has actually been witnessed', () => {
    const id = 'veh-observed-stop'
    const stoppedMovingAt = Date.now() - 300 * MIN

    // Witnessed moving → stopped with ignition on, so `exact` becomes true and
    // the backdating branch must not fire: the run began when we saw it stop.
    noteMovement(id, 60, Date.now() - 20 * MIN, true)
    noteMovement(id, 0,  Date.now() - 15 * MIN, true)
    noteMovement(id, 0,  Date.now() - 11 * MIN, true)   // past the stop grace
    noteMovement(id, 0,  Date.now() - 1 * MIN,  true)

    const m = movementState(id, new Date(stoppedMovingAt), Date.now() - 1 * MIN)
    expect(m?.state).toBe('idling')
    expect(Date.parse(m!.since)).not.toBe(stoppedMovingAt)
  })
})
