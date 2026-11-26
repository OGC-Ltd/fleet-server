/**
 * Generators have no speed and no speed limit (operator, 2026-11-26).
 *
 * What these pin: the ten generators on the platform that day — named, all
 * typed UNSPECIFIED — are recognised; `overspeedLimitFor` gives them no limit;
 * a sustained drift reading never raises overspeeding, an incident episode or
 * a playback speeding run; and a truck beside them is judged exactly as before.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { isGeneratorUnit } from '../../src/lib/generator.js'
import { deriveAlertFlags, overspeedLimitFor, resetDerivationState } from '../../src/lib/derived-alerts.js'
import { playbackLimitFor } from '../../src/modules/telemetry/playback-events.js'
import { env } from '../../src/config/env.js'
import type { VehicleTelemetryFrame } from '../../src/providers/telemetry-provider.js'

const GENERATORS = [
  'MUFINDI: DG 06', 'MUFINDI: DG 08', 'MUFINDI: DG 09',
  'MUFINDI - DG 11', 'MUFINDI - DG 12', 'MUFINDI - DG 13',
  'MORL FARM EQUIPMENT - GENSET DAMP SITE', 'MORL FARM EQUIPMENT - GENSET MOLO RIVER',
  'MORL FARM EQUIPMENT - GENSET TEACHERS', 'MORL FARM  - GENSET PACKHOUSE',
]

let t = Date.UTC(2026, 10, 26, 12, 0, 0)
const frame = (speedKmh: number): VehicleTelemetryFrame => {
  t += 2_000
  return {
    deviceId: 'wialon:1', capturedAt: new Date(t), lat: 0, lng: 0, speedKmh,
    engineOn: true, ignitionKnown: true, fuelLevelMl: null,
    flags: { overspeeding: false },
  } as unknown as VehicleTelemetryFrame
}

beforeEach(() => { resetDerivationState() })

describe('generators', () => {
  it.each(GENERATORS)('%s is a generator', (name) => {
    expect(isGeneratorUnit(name, 'UNSPECIFIED')).toBe(true)
  })

  it('a GENERATOR type is one whatever its name', () => {
    expect(isGeneratorUnit('KDA 123A', 'GENERATOR')).toBe(true)
  })

  it.each(['MUFINDI - FT 13', 'MUFINDI: OPTIM - CM 01', 'KDE 585S', 'LMV 04', 'MUFINDI - DGT 1'])('%s is not', (name) => {
    expect(isGeneratorUnit(name, 'TRUCK')).toBe(false)
  })

  it('has no limit, where a truck keeps the fleet one', () => {
    expect(overspeedLimitFor('UNSPECIFIED', undefined, 'MUFINDI: DG 09')).toBeNull()
    expect(playbackLimitFor('UNSPECIFIED', 'MUFINDI: DG 09')).toBeNull()
    expect(overspeedLimitFor('UNSPECIFIED', undefined, 'MUFINDI - FT 13')).toBe(env.OVERSPEED_LIMIT_KMH)
  })

  it('never raises overspeeding on a sustained drift reading', () => {
    const ctx = { vehicleId: 'dg09', tankCapacityMl: 1_696_000, vehicleType: 'UNSPECIFIED', registrationPlate: 'MUFINDI: DG 09' }
    let last
    for (let i = 0; i < env.OVERSPEED_MIN_FRAMES + 3; i++) last = deriveAlertFlags(frame(140), ctx)
    expect(last!.overspeeding).toBeUndefined()
  })

  it('a truck at the same speed still does', () => {
    const ctx = { vehicleId: 'ft13', tankCapacityMl: 400_000, vehicleType: 'UNSPECIFIED', registrationPlate: 'MUFINDI - FT 13' }
    let last
    for (let i = 0; i < env.OVERSPEED_MIN_FRAMES; i++) last = deriveAlertFlags(frame(140), ctx)
    expect(last!.overspeeding).toBe(true)
  })
})
