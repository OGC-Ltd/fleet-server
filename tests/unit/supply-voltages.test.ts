import { describe, it, expect } from 'vitest'
import { readVoltages } from '../../src/providers/wialon/wialon.sensors.js'
import { applyVolts, hasVoltages } from '../../src/modules/telemetry/day-voltage-fill.js'
import { voltColumns } from '../../src/modules/ingest/ingest.service.js'

// Operator, 2026-10-13: the Fuel Report graph's two voltage lines, stored from
// now on and read from Wialon for a day that has none.
describe('readVoltages', () => {
  it('reads pwr_ext and pwr_int in volts', () => {
    expect(readVoltages({ pwr_ext: 27.99, pwr_int: 4.08 })).toEqual({ ext: 27.99, int: 4.08 })
  })
  it('reads millivolts as volts, and text as a number', () => {
    expect(readVoltages({ pwr_ext: 12650, pwr_int: '4100' })).toEqual({ ext: 12.65, int: 4.1 })
  })
  it('drops what no supply reads, and returns null for a message with neither', () => {
    expect(readVoltages({ pwr_ext: -3, pwr_int: 4 })).toEqual({ ext: null, int: 4 })
    expect(readVoltages({ io_17: 1 })).toBeNull()
    expect(readVoltages(undefined)).toBeNull()
  })
})

describe('applyVolts', () => {
  it('matches the readings to the messages by second', () => {
    const d = { from: 1_000_000, to: 2_000_000, t: [0, 30, 60] }
    const n = applyVolts(d, new Map([[1000, { ext: 24.1, int: 4 }], [1060, { ext: 27.9, int: null }]]))
    expect(n).toBe(2)
    expect(d).toMatchObject({ vext: [24.1, null, 27.9], vint: [4, null, null] })
    expect(hasVoltages(d)).toBe(true)
  })
  it('leaves a day it matched nothing on untouched', () => {
    const d = { from: 0, to: 1, t: [0], vext: [null], vint: [null] }
    expect(applyVolts(d, new Map())).toBe(0)
    expect(hasVoltages(d)).toBe(false)
  })
})

describe('voltColumns', () => {
  it('always writes both, null where absent or impossible', () => {
    expect(voltColumns({ extVoltageV: 13.2 } as never)).toEqual({ extVoltageV: 13.2, intVoltageV: null })
    expect(voltColumns({ extVoltageV: 900, intVoltageV: NaN } as never)).toEqual({ extVoltageV: null, intVoltageV: null })
  })
})
