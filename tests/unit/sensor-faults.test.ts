/**
 * Sensor faults, frame-driven half.
 *
 * The headline requirement is an ACCURATE started timestamp. The browser
 * detector this replaces stamps `Date.now()` — reload the page and every fault
 * appears to have just started — so the tests that matter are the ones pinning
 * where each start actually comes from.
 *
 * The second is the guard that keeps a healthy fleet free: `noteAlive` runs on
 * every frame of every unit, and if it published unconditionally the worker
 * would run a database lookup ~750 times a second for units with nothing wrong.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/event-bus.js', () => ({
  eventBus: { publish: vi.fn(), subscribe: vi.fn() },
}))

const { env } = await import('../../src/config/env.js')
env.INCIDENT_CAPTURE_ENABLED = true
env.SENSOR_FAULT_MIN_FRAMES = 2

const { eventBus } = await import('../../src/lib/event-bus.js')
const { noteMovement } = await import('../../src/lib/movement-state.js')
const {
  noteFaultFrame, noteAlive, markSilent, resetFaultState, silentCount,
} = await import('../../src/lib/sensor-faults.js')

/**
 * Anchored to NOW, not to a fixed calendar date.
 *
 * `movementState` collapses a run to "resting" once its newest fix is older
 * than STALE_FIX_MS (1 h) against the wall clock — correctly, a silent unit is
 * not driving. A fixture dated to a fixed day is therefore hours stale by the
 * time the suite runs, and the transit rule can never fire.
 */
const T0 = Date.now() - 20 * 60_000
const SEC = 1000

/**
 * A fresh vehicle id per test.
 *
 * `movement-state` keeps per-vehicle state and exposes no reset — deliberately,
 * it is live tracking state, not a fixture. Rather than add a test-only export
 * to production code, each test gets a unit nothing else has touched.
 */
let seq = 0
let ctx = { orgId: 'org1', vehicleId: 'veh0' }

const frame = (o: Partial<Record<string, unknown>> = {}) => ({
  deviceId: 'wialon:1', capturedAt: new Date(T0),
  lat: -0.82, lng: 34.38, accuracyM: 10,
  speedKmh: 0, engineOn: true, ignitionKnown: true,
  ...o,
} as never)

beforeEach(() => {
  seq += 1
  ctx = { orgId: 'org1', vehicleId: `veh${seq}` }
  resetFaultState()
  vi.mocked(eventBus.publish).mockClear()
})

const opens = () => vi.mocked(eventBus.publish).mock.calls
  .filter(c => c[0] === 'sensorFault:open').map(c => c[1] as never)

describe('speed with the ignition off', () => {
  it('is not claimed when the unit reports no ignition channel at all', () => {
    // The browser rule reads `engine === 'off'` and cannot tell an unfitted
    // channel from a fault, so it accuses every unit without an ignition line.
    for (let i = 0; i < 3; i++) {
      noteFaultFrame(frame({ capturedAt: new Date(T0 + i * SEC), speedKmh: 40, engineOn: false, ignitionKnown: false }), ctx)
    }
    expect(opens()).toHaveLength(0)
  })

  it('is raised once the ignition is genuinely measured off', () => {
    noteFaultFrame(frame({ capturedAt: new Date(T0), speedKmh: 40, engineOn: false }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), speedKmh: 42, engineOn: false }), ctx)

    const [o] = opens() as Array<{ kind: string; severity: string; source: string }>
    expect(o.kind).toBe('speed_no_engine')
    expect(o.severity).toBe('critical')
    expect(o.source).toBe('poller')
  })

  it('waits for the debounce so one noisy fix raises nothing', () => {
    noteFaultFrame(frame({ speedKmh: 40, engineOn: false }), ctx)
    expect(opens()).toHaveLength(0)
  })
})

describe('in transit with the ignition off', () => {
  it('starts when the unit STARTED MOVING, not when we noticed', () => {
    // Six minutes of movement already on the clock before the first fault frame.
    noteMovement(ctx.vehicleId, 30, T0, true)
    noteMovement(ctx.vehicleId, 30, T0 + 6 * 60 * SEC, true)

    const at = T0 + 6 * 60 * SEC
    noteFaultFrame(frame({ capturedAt: new Date(at), speedKmh: 30, engineOn: false }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(at + SEC), speedKmh: 30, engineOn: false }), ctx)

    const transit = (opens() as Array<{ kind: string; startedAt: Date }>)
      .find(o => o.kind === 'transit_no_engine')
    expect(transit).toBeDefined()
    // The movement tracker's `since`, which backdates past the stop grace —
    // NOT the frame that happened to prove the contradiction.
    expect(transit!.startedAt.getTime()).toBe(T0)
  })

  it('is not raised before the five-minute grace', () => {
    noteMovement(ctx.vehicleId, 30, T0, true)
    noteMovement(ctx.vehicleId, 30, T0 + 60 * SEC, true)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + 60 * SEC), speedKmh: 30, engineOn: false }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + 61 * SEC), speedKmh: 30, engineOn: false }), ctx)

    expect((opens() as Array<{ kind: string }>).some(o => o.kind === 'transit_no_engine')).toBe(false)
  })
})

describe('position faults', () => {
  it('reports a frame that arrived with no fix', () => {
    noteFaultFrame(frame({ lat: null, lng: null }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), lat: null, lng: null }), ctx)
    expect((opens() as Array<{ kind: string }>)[0]!.kind).toBe('frozen_gps')
  })

  it('treats a null island fix as no fix', () => {
    noteFaultFrame(frame({ lat: 0, lng: 0 }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), lat: 0, lng: 0 }), ctx)
    expect((opens() as Array<{ kind: string }>)[0]!.kind).toBe('frozen_gps')
  })

  it('does not complain twice about one broken position', () => {
    // A coarse accuracy figure beside a missing position is the same problem.
    noteFaultFrame(frame({ lat: null, lng: null, accuracyM: 5000 }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), lat: null, lng: null, accuracyM: 5000 }), ctx)
    const kinds = (opens() as Array<{ kind: string }>).map(o => o.kind)
    expect(kinds).toEqual(['frozen_gps'])
  })

  it('reports a fix too coarse to use', () => {
    noteFaultFrame(frame({ accuracyM: 800 }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), accuracyM: 800 }), ctx)
    expect((opens() as Array<{ kind: string }>)[0]!.kind).toBe('low_accuracy')
  })
})

describe('recovery', () => {
  it('closes at the first frame that no longer shows the fault', () => {
    noteFaultFrame(frame({ speedKmh: 40, engineOn: false }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), speedKmh: 40, engineOn: false }), ctx)
    vi.mocked(eventBus.publish).mockClear()

    const recoveredAt = new Date(T0 + 10 * SEC)
    noteFaultFrame(frame({ capturedAt: recoveredAt, speedKmh: 0, engineOn: true }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + 11 * SEC), speedKmh: 0, engineOn: true }), ctx)

    const closes = vi.mocked(eventBus.publish).mock.calls.filter(c => c[0] === 'sensorFault:close')
    expect(closes).toHaveLength(1)
    expect((closes[0]![1] as { kind: string }).kind).toBe('speed_no_engine')
  })

  it('does not close an episode that never opened', () => {
    noteFaultFrame(frame({ speedKmh: 40, engineOn: false }), ctx)   // one frame only
    noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), speedKmh: 0, engineOn: true }), ctx)
    noteFaultFrame(frame({ capturedAt: new Date(T0 + 2 * SEC), speedKmh: 0, engineOn: true }), ctx)

    const closes = vi.mocked(eventBus.publish).mock.calls.filter(c => c[0] === 'sensorFault:close')
    expect(closes).toHaveLength(0)
  })
})

describe('noteAlive stays off the hot path', () => {
  it('publishes nothing for a unit the sweep never flagged', () => {
    // ~1,500 units every 2 s: an unconditional publish here would be roughly
    // 750 database lookups a second for units with nothing wrong.
    for (let i = 0; i < 50; i++) noteAlive(frame({ capturedAt: new Date(T0 + i * SEC) }), ctx)
    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('publishes exactly once for a unit that was silent, then stops', () => {
    markSilent(ctx.vehicleId)
    expect(silentCount()).toBe(1)

    noteAlive(frame(), ctx)
    noteAlive(frame({ capturedAt: new Date(T0 + SEC) }), ctx)

    const closes = vi.mocked(eventBus.publish).mock.calls.filter(c => c[0] === 'sensorFault:close')
    expect(closes).toHaveLength(1)
    expect((closes[0]![1] as { kind: string; recoveredAt: Date }).kind).toBe('signal_lost')
    // The ping's own time, not the sweep's grid.
    expect((closes[0]![1] as { recoveredAt: Date }).recoveredAt.getTime()).toBe(T0)
    expect(silentCount()).toBe(0)
  })
})

describe('the capture flag', () => {
  it('records nothing while INCIDENT_CAPTURE_ENABLED is false', () => {
    env.INCIDENT_CAPTURE_ENABLED = false
    try {
      markSilent(ctx.vehicleId)
      noteFaultFrame(frame({ speedKmh: 40, engineOn: false }), ctx)
      noteFaultFrame(frame({ capturedAt: new Date(T0 + SEC), speedKmh: 40, engineOn: false }), ctx)
      noteAlive(frame(), ctx)
      expect(eventBus.publish).not.toHaveBeenCalled()
    } finally {
      env.INCIDENT_CAPTURE_ENABLED = true
    }
  })
})
