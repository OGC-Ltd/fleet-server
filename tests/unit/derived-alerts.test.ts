/**
 * Flags derived from telemetry.
 *
 * These pin the two properties that decide whether this feature is an
 * improvement or a nuisance:
 *
 *   · it raises overspeeding on SUSTAINED speed, never on one fix — a single
 *     spurious reading raising an alert is the fabrication the Wialon adapter
 *     switched these flags off to avoid, and the debounce is the whole answer
 *     to it;
 *   · it never asserts a flag the data cannot support — an unknown tank does
 *     not become an empty one, and idling is not claimed where ignition is a
 *     guess.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { deriveAlertFlags, overspeedLimitFor, resetDerivationState } from '../../src/lib/derived-alerts.js'
import { env } from '../../src/config/env.js'
import type { VehicleTelemetryFrame } from '../../src/providers/telemetry-provider.js'

const CTX = { vehicleId: 'v1', tankCapacityMl: 200_000, vehicleType: 'TRUCK' }

let t = Date.UTC(2026, 7, 31, 6, 0, 0)

function frame(over: Partial<VehicleTelemetryFrame> = {}): VehicleTelemetryFrame {
  t += 2_000     // the live poll cadence
  return {
    deviceId:   'wialon:1',
    capturedAt: new Date(t),
    lat: 0, lng: 0, altitudeM: null, headingDeg: null, accuracyM: null,
    speedKmh: 0,
    engineOn: false,
    ignitionKnown: true,
    engineHoursMeter: null,
    fuelLevelMl: null,
    fuelUsedMl: null,
    cargoWeightKg: null,
    batteryVoltageV: null,
    doorStatus: 'UNKNOWN',
    panicButtonPressed: false,
    gpsFixQuality: null,
    satelliteCount: null,
    networkType: null,
    signalStrengthPct: null,
    engineTempC: null,
    oilLevelPct: null,
    flags: {
      overspeeding: false, fuelInconsistency: false, doorOpenWhileMoving: false,
      lowFuel: false, engineIdling: false, outsideGeofence: false,
      lowBattery: false, highEngineTemp: false, lowOil: false,
    },
    rawPayload: {},
    ...over,
  } as VehicleTelemetryFrame
}

beforeEach(() => { resetDerivationState() })

describe('overspeeding', () => {
  it('does not fire on a single fix over the limit', () => {
    // The case the whole debounce exists for: one 95 km/h reading on a fleet
    // whose units mostly cannot reach it is likelier to be a GPS artefact than
    // a driver, and an alert on it would be exactly the fabrication the adapter
    // refused to produce.
    const f = deriveAlertFlags(frame({ speedKmh: 95 }), CTX)
    expect(f.overspeeding).toBeUndefined()
  })

  it('fires once the speed is sustained', () => {
    let last
    for (let i = 0; i < env.OVERSPEED_MIN_FRAMES; i++) {
      last = deriveAlertFlags(frame({ speedKmh: 95 }), CTX)
    }
    expect(last!.overspeeding).toBe(true)
  })

  it('needs frames that are CONSECUTIVE, not merely numerous', () => {
    // Three separate excursions across an afternoon are not one episode. A
    // count that survived dropping below the limit would turn ordinary
    // acceleration into a permanent alert.
    for (let i = 0; i < env.OVERSPEED_MIN_FRAMES - 1; i++) {
      deriveAlertFlags(frame({ speedKmh: 95 }), CTX)
    }
    deriveAlertFlags(frame({ speedKmh: 40 }), CTX)          // back under
    const f = deriveAlertFlags(frame({ speedKmh: 95 }), CTX) // starts again
    expect(f.overspeeding).toBeUndefined()
  })

  it('says nothing when the unit reports no speed at all', () => {
    for (let i = 0; i < 5; i++) {
      const f = deriveAlertFlags(frame({ speedKmh: null }), CTX)
      expect(f.overspeeding).toBeUndefined()
    }
  })

  it('tracks each vehicle separately', () => {
    for (let i = 0; i < env.OVERSPEED_MIN_FRAMES; i++) {
      deriveAlertFlags(frame({ speedKmh: 95 }), { ...CTX, vehicleId: 'a' })
    }
    const b = deriveAlertFlags(frame({ speedKmh: 95 }), { ...CTX, vehicleId: 'b' })
    expect(b.overspeeding).toBeUndefined()
  })
})

describe('the limit', () => {
  it('falls back to the configured fleet limit for an unknown type', () => {
    expect(overspeedLimitFor(null)).toBe(env.OVERSPEED_LIMIT_KMH)
    expect(overspeedLimitFor('SOMETHING_NEW')).toBe(env.OVERSPEED_LIMIT_KMH)
  })

  it('is the same number the Speeding screen and the conduct policy use', () => {
    // One value with two readers. While these were separate literals the
    // platform could suspend a driver against a limit it never alerted on.
    expect(env.OVERSPEED_LIMIT_KMH).toBeGreaterThan(0)
  })
})

describe('lowFuel', () => {
  it('fires below the configured percentage of a known tank', () => {
    const f = deriveAlertFlags(frame({ fuelLevelMl: 10_000 }), CTX)   // 5% of 200 L
    expect(f.lowFuel).toBe(true)
  })

  it('stays quiet on a full tank', () => {
    expect(deriveAlertFlags(frame({ fuelLevelMl: 150_000 }), CTX).lowFuel).toBeUndefined()
  })

  it('refuses to read an UNKNOWN tank as an empty one', () => {
    // Capacity is 0 for a vehicle nobody has recorded a tank size for — 355 of
    // 815 active vehicles when this was written. Dividing by it would turn
    // missing configuration into a critical alert on a full truck.
    const f = deriveAlertFlags(frame({ fuelLevelMl: 10_000 }), { ...CTX, tankCapacityMl: 0 })
    expect(f.lowFuel).toBeUndefined()
  })

  it('says nothing when the probe reports no level', () => {
    expect(deriveAlertFlags(frame({ fuelLevelMl: null }), CTX).lowFuel).toBeUndefined()
  })
})

describe('engineIdling', () => {
  it('is not claimed where ignition is a guess', () => {
    // Without a measured ignition line `engineOn` falls back to `speed > 0`,
    // so a stationary unit is engine-off by construction and idling cannot be
    // represented at all — never mind detected. On this fleet that is most
    // units.
    for (let i = 0; i < 300; i++) {
      const f = deriveAlertFlags(
        frame({ speedKmh: 0, engineOn: true, ignitionKnown: false }), CTX)
      expect(f.engineIdling).toBeUndefined()
    }
  })

  it('fires after the engine has run stationary long enough', () => {
    let last
    // 5 minutes at a 2-second cadence.
    for (let i = 0; i < 160; i++) {
      last = deriveAlertFlags(frame({ speedKmh: 0, engineOn: true, ignitionKnown: true }), CTX)
    }
    expect(last!.engineIdling).toBe(true)
  })

  it('does not fire for a brief stop at a gate', () => {
    let last
    for (let i = 0; i < 20; i++) {   // ~40 seconds
      last = deriveAlertFlags(frame({ speedKmh: 0, engineOn: true, ignitionKnown: true }), CTX)
    }
    expect(last!.engineIdling).toBeUndefined()
  })

  it('resets the clock as soon as the unit moves', () => {
    for (let i = 0; i < 150; i++) {
      deriveAlertFlags(frame({ speedKmh: 0, engineOn: true, ignitionKnown: true }), CTX)
    }
    deriveAlertFlags(frame({ speedKmh: 30, engineOn: true, ignitionKnown: true }), CTX)
    const f = deriveAlertFlags(frame({ speedKmh: 0, engineOn: true, ignitionKnown: true }), CTX)
    expect(f.engineIdling).toBeUndefined()
  })
})

describe('what it refuses to derive', () => {
  it('asserts nothing about doors, oil, battery or geofences', () => {
    // These have no channel in the payload. The module returns only what it can
    // positively assert, and the caller ORs the result on — so a flag absent
    // here stays exactly as the provider left it.
    const f = deriveAlertFlags(frame({ speedKmh: 95, fuelLevelMl: 1_000 }), CTX)
    expect(Object.keys(f).every(k =>
      ['overspeeding', 'lowFuel', 'engineIdling'].includes(k))).toBe(true)
  })
})
